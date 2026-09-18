import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { AppError } from '@berelax/shared'
import type { UnitOfWork } from '../tx.ts'

/**
 * SMS one-time codes: issue, verify, rate-limit, lock.
 *
 * ## The code is returned to the caller and stored nowhere
 *
 * `issueOtpChallenge` returns the plaintext code exactly once, to the caller that is about to hand it
 * to `sendMessage`. Nothing writes it down: the row holds an HMAC under a per-row salt, the audit
 * event holds the challenge id and the purpose, and no log line here takes the code as an argument.
 *
 * That is not theatre. The window is five minutes and the code is six digits, so anything holding a
 * live code — a table, a log, a pg-boss payload, a Sentry breadcrumb — is a credential store with a
 * five-minute retention policy. The hash is what makes a database dump worthless; the salt is what
 * stops two challenges that happen to share a code from looking identical, which would otherwise let
 * somebody who knows one code read the other.
 *
 * The hash is fast on purpose and that is a deliberate trade. A six-digit code has a million values,
 * so no work factor is going to save it from an offline attack; what protects it is that it lives for
 * five minutes, verifies once, and locks the number after five wrong guesses. Spending 100ms per
 * verification would buy nothing and would put a visible, measurable cost on the one path that has to
 * be indistinguishable from the other (see the enumeration note below).
 *
 * ## Why every instant is an argument
 *
 * No function here calls `now()` in SQL or reads the clock in JavaScript. Expiry, the rate-limit
 * window and the lock are the four things this unit has to prove, and all four are statements about
 * time: under a real clock they are provable only by waiting five, fifteen and sixty real minutes,
 * which means in practice they are never proved at all. The caller passes the instant; the tests pass
 * a frozen one.
 *
 * ## Why the failure counter is per number
 *
 * `otp_phone_lock` is keyed on the phone, not on the challenge. A counter on the challenge row is
 * reset by requesting a new code, so five attempts becomes five attempts *per code* and an attacker
 * presses "resend" every fifth guess. Migration 0019 carries the same note.
 *
 * ## Why an unknown number is not a special case
 *
 * Nothing in this module reads the `customer` table, and `otp_challenge.phone_e164` is not a foreign
 * key. A request for a number nobody has seen does exactly what a request for a regular customer
 * does, in the same statements, because the cheapest way to make two paths indistinguishable is to
 * have one path. That is what the enumeration-resistance timing test in
 * `apps/web/src/otp-route.itest.ts` measures, and what it would catch if somebody added a lookup here.
 */

/** Six digits, as every SMS OTP in this market is, and as `auth.otp` renders. */
export const OTP_CODE_DIGITS = 6

/** Five minutes. Long enough for a slow SMS route, short enough that a stolen handset is no use. */
export const OTP_TTL_MINUTES = 5

/** Wrong guesses before the number is locked. */
export const OTP_MAX_FAILED_ATTEMPTS = 5

/** How long the number stays locked after that. */
export const OTP_LOCK_MINUTES = 15

/**
 * Requests per number per window.
 *
 * Three in fifteen minutes. A customer whose SMS is slow will press resend once, maybe twice; a
 * fourth request inside the window is either a bug or somebody using this endpoint to send SMS at
 * somebody else, and every one of those messages is a real charge on the SMSala account.
 */
export const OTP_MAX_REQUESTS_PER_PHONE = 3
export const OTP_PHONE_WINDOW_MINUTES = 15

/**
 * Requests per IP per window.
 *
 * Looser than the per-number limit and for a different failure: a household, a hotel or the salon's
 * own wifi legitimately produces several numbers from one address, so this cannot be three. Ten an
 * hour stops a script enumerating numbers from one address without inconveniencing a family.
 */
export const OTP_MAX_REQUESTS_PER_IP = 10
export const OTP_IP_WINDOW_MINUTES = 60

export const OTP_PURPOSES = ['booking_verify', 'view_bookings', 'clinical_flags'] as const
export type OtpPurpose = (typeof OTP_PURPOSES)[number]

export const OTP_RATE_LIMITS = ['phone', 'ip'] as const
export type OtpRateLimit = (typeof OTP_RATE_LIMITS)[number]

export const OTP_VERIFY_REJECTIONS = [
  'locked',
  'no_live_challenge',
  'expired',
  'wrong_code',
] as const
export type OtpVerifyRejection = (typeof OTP_VERIFY_REJECTIONS)[number]

export interface OtpIssueRequest {
  /** Canonical E.164, from `normalisePhone` in `@berelax/core`. Never a raw form value. */
  readonly phoneE164: string
  readonly purpose: OtpPurpose
  /** The instant of the request, from an injected clock. */
  readonly nowIso: string
  /** Null when the edge did not supply one, never a placeholder: a fake IP is a fake rate limit. */
  readonly requestIp: string | null
  readonly requestId: string | null
}

export type OtpIssueResult =
  | {
      readonly kind: 'issued'
      readonly challengeId: string
      /** Returned once, for the send. Never stored, never logged. */
      readonly code: string
      readonly expiresAtIso: string
      readonly ttlSeconds: number
    }
  | {
      readonly kind: 'rate_limited'
      readonly limit: OtpRateLimit
      readonly retryAfterSeconds: number
    }
  | { readonly kind: 'locked'; readonly retryAfterSeconds: number }

export interface OtpVerifyRequest {
  readonly phoneE164: string
  readonly purpose: OtpPurpose
  readonly code: string
  readonly nowIso: string
}

export type OtpVerifyResult =
  | { readonly kind: 'verified'; readonly challengeId: string }
  | {
      readonly kind: 'rejected'
      readonly reason: OtpVerifyRejection
      /** Attempts left before the number locks. Zero once it is locked. */
      readonly attemptsRemaining: number
      /** Seconds until the lock lifts, or null when nothing is locked. */
      readonly retryAfterSeconds: number | null
    }

const MINUTE_MS = 60_000

function instantOf(iso: string, field: string): number {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) {
    throw new AppError('validation', `${field} must be a parseable instant, received "${iso}"`)
  }
  return ms
}

const isoAt = (ms: number): string => new Date(ms).toISOString()

/**
 * A six-digit code from the CSPRNG.
 *
 * `randomInt` and not `Math.random`: the second is seeded from something an attacker can often
 * predict, and a predictable OTP is not an OTP. Leading zeros are kept — `042917` is a valid code and
 * a generator that avoided them would throw away a tenth of the space for the sake of tidiness.
 */
export function generateOtpCode(): string {
  return String(randomInt(0, 10 ** OTP_CODE_DIGITS)).padStart(OTP_CODE_DIGITS, '0')
}

/** HMAC-SHA-256 of the code under the row salt. The only representation of a code that is stored. */
export function hashOtpCode(code: string, salt: Buffer): Buffer {
  return createHmac('sha256', salt).update(code, 'utf8').digest()
}

/**
 * Constant-time comparison.
 *
 * `Buffer.equals` returns on the first differing byte, which leaks how much of a guess was right.
 * With six digits and a live challenge that is a small leak; it is also free to close, and the
 * version of this function that compares with `===` is the one somebody writes at 2am.
 */
function hashesMatch(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

interface CountRow {
  readonly requests: string
  readonly oldest: Date | null
}

/**
 * Checks both limits, oldest-request-first so the caller can be told when to come back.
 *
 * Counting is over *issued* challenges, so a request that was refused does not extend its own
 * penalty. The window slides off the oldest row rather than resetting on the hour: a fixed window
 * lets somebody send double the allowance across its boundary, which for SMS is double the bill.
 */
async function rateLimitExceeded(
  uow: UnitOfWork,
  request: OtpIssueRequest,
  nowMs: number,
): Promise<{ limit: OtpRateLimit; retryAfterSeconds: number } | null> {
  const phoneWindowStart = isoAt(nowMs - OTP_PHONE_WINDOW_MINUTES * MINUTE_MS)
  const [phone] = await uow.sql<CountRow[]>`
    select count(*)::text as requests, min(issued_at) as oldest
    from otp_challenge
    where phone_e164 = ${request.phoneE164} and issued_at > ${phoneWindowStart}
  `
  if (phone !== undefined && Number(phone.requests) >= OTP_MAX_REQUESTS_PER_PHONE) {
    return {
      limit: 'phone',
      retryAfterSeconds: retryAfter(phone.oldest, nowMs, OTP_PHONE_WINDOW_MINUTES),
    }
  }

  if (request.requestIp === null) return null

  const ipWindowStart = isoAt(nowMs - OTP_IP_WINDOW_MINUTES * MINUTE_MS)
  const [ip] = await uow.sql<CountRow[]>`
    select count(*)::text as requests, min(issued_at) as oldest
    from otp_challenge
    where request_ip = ${request.requestIp}::inet and issued_at > ${ipWindowStart}
  `
  if (ip !== undefined && Number(ip.requests) >= OTP_MAX_REQUESTS_PER_IP) {
    return { limit: 'ip', retryAfterSeconds: retryAfter(ip.oldest, nowMs, OTP_IP_WINDOW_MINUTES) }
  }
  return null
}

function retryAfter(oldest: Date | null, nowMs: number, windowMinutes: number): number {
  if (oldest === null) return windowMinutes * 60
  const freesAt = oldest.getTime() + windowMinutes * MINUTE_MS
  return Math.max(1, Math.ceil((freesAt - nowMs) / 1000))
}

interface LockRow {
  readonly consecutive_failures: number
  readonly locked_until: Date | null
}

/**
 * Reads the lock, clearing it first if it has expired.
 *
 * Clearing on read rather than on a schedule: there is no job to forget to run, and the alternative —
 * leaving a stale `locked_until` in place and compensating for it in every later comparison — is the
 * shape of bug that locks somebody out permanently.
 */
async function currentLock(uow: UnitOfWork, phoneE164: string, nowIso: string): Promise<LockRow> {
  await uow.sql`
    update otp_phone_lock
    set consecutive_failures = 0, locked_until = null
    where phone_e164 = ${phoneE164} and locked_until is not null and locked_until <= ${nowIso}
  `
  const [row] = await uow.sql<LockRow[]>`
    select consecutive_failures, locked_until from otp_phone_lock where phone_e164 = ${phoneE164}
  `
  return row ?? { consecutive_failures: 0, locked_until: null }
}

/**
 * Issues a code, or refuses with a reason.
 *
 * Takes a {@link UnitOfWork} rather than a connection, for the reason `allocateDocumentNumber` does:
 * the supersede, the insert and the audit row must commit together. A challenge with no audit row is
 * an OTP nobody can account for, and an audit row with no challenge is worse.
 */
export async function issueOtpChallenge(
  uow: UnitOfWork,
  request: OtpIssueRequest,
): Promise<OtpIssueResult> {
  const nowMs = instantOf(request.nowIso, 'nowIso')

  const lock = await currentLock(uow, request.phoneE164, request.nowIso)
  if (lock.locked_until !== null) {
    const retryAfterSeconds = Math.max(1, Math.ceil((lock.locked_until.getTime() - nowMs) / 1000))
    await uow.audit.record({
      action: 'otp.refused_locked',
      entityType: 'otp_challenge',
      operation: 'denied',
      after: { phone_e164: request.phoneE164, purpose: request.purpose, retryAfterSeconds },
    })
    return { kind: 'locked', retryAfterSeconds }
  }

  const exceeded = await rateLimitExceeded(uow, request, nowMs)
  if (exceeded !== null) {
    // Audited, and audited with WHICH limit fired: "rate limited" with no dimension is a row nobody
    // can act on, and the two limits have completely different remedies.
    await uow.audit.record({
      action: 'otp.rate_limited',
      entityType: 'otp_challenge',
      operation: 'denied',
      after: {
        phone_e164: request.phoneE164,
        purpose: request.purpose,
        limit: exceeded.limit,
        retryAfterSeconds: exceeded.retryAfterSeconds,
      },
    })
    return { kind: 'rate_limited', ...exceeded }
  }

  // Only the newest code may verify. Without this, a resend leaves two live codes and an intercepted
  // earlier SMS keeps working for its full five minutes.
  await uow.sql`
    update otp_challenge
    set superseded_at = ${request.nowIso}
    where phone_e164 = ${request.phoneE164}
      and purpose = ${request.purpose}
      and consumed_at is null
      and superseded_at is null
      and expires_at > ${request.nowIso}
  `

  const code = generateOtpCode()
  const salt = randomBytes(16)
  const expiresAtIso = isoAt(nowMs + OTP_TTL_MINUTES * MINUTE_MS)

  const [inserted] = await uow.sql<{ id: string }[]>`
    insert into otp_challenge (
      phone_e164, purpose, code_hash, code_salt, issued_at, expires_at, request_ip, request_id
    ) values (
      ${request.phoneE164},
      ${request.purpose},
      ${hashOtpCode(code, salt)},
      ${salt},
      ${request.nowIso},
      ${expiresAtIso},
      ${request.requestIp},
      ${request.requestId}
    )
    returning id
  `
  if (inserted === undefined) {
    throw new AppError('invariant_violated', 'Inserting an OTP challenge returned no row.')
  }

  // The audit row carries the challenge, the purpose and the number. It must never carry the code —
  // audit_event is append-only and read by staff, so a code in it is a code that cannot be redacted.
  await uow.audit.record({
    action: 'otp.issued',
    entityType: 'otp_challenge',
    entityId: inserted.id,
    operation: 'create',
    after: {
      phone_e164: request.phoneE164,
      purpose: request.purpose,
      expires_at: expiresAtIso,
      ttl_minutes: OTP_TTL_MINUTES,
    },
  })

  return {
    kind: 'issued',
    challengeId: inserted.id,
    code,
    expiresAtIso,
    ttlSeconds: OTP_TTL_MINUTES * 60,
  }
}

interface ChallengeRow {
  readonly id: string
  readonly code_hash: Buffer
  readonly code_salt: Buffer
  readonly expires_at: Date
}

/**
 * Verifies a code against the newest live challenge for that number and purpose.
 *
 * Single use, five minutes, five attempts. Every one of those is enforced here rather than by the
 * caller, because there will be several callers — the booking flow, the history view, the clinical
 * flags screen — and a rule enforced per call site is a rule with one exception per call site.
 */
export async function verifyOtpCode(
  uow: UnitOfWork,
  request: OtpVerifyRequest,
): Promise<OtpVerifyResult> {
  const nowMs = instantOf(request.nowIso, 'nowIso')
  const lock = await currentLock(uow, request.phoneE164, request.nowIso)
  if (lock.locked_until !== null) {
    return {
      kind: 'rejected',
      reason: 'locked',
      attemptsRemaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((lock.locked_until.getTime() - nowMs) / 1000)),
    }
  }

  // `for update` because two submissions of the same code race otherwise, and the loser would find
  // the row already consumed and report a wrong code for a code that was right.
  const [challenge] = await uow.sql<ChallengeRow[]>`
    -- Deliberately not selecting failed_attempts. That column records what happened to THIS
    -- challenge, for anybody reading the table later; the counter the lock is made of lives on
    -- otp_phone_lock, and reading both here is how the wrong one ends up being enforced.
    select id, code_hash, code_salt, expires_at
    from otp_challenge
    where phone_e164 = ${request.phoneE164}
      and purpose = ${request.purpose}
      and consumed_at is null
      and superseded_at is null
    order by issued_at desc
    limit 1
    for update
  `
  if (challenge === undefined) {
    // Covers both "never asked for a code" and "already used the one they had". Deliberately one
    // reason rather than two: telling a caller the code was already used tells an attacker holding a
    // captured SMS that somebody beat them to it, which is information about the victim.
    return {
      kind: 'rejected',
      reason: 'no_live_challenge',
      attemptsRemaining: remaining(lock.consecutive_failures),
      retryAfterSeconds: null,
    }
  }

  if (challenge.expires_at.getTime() <= nowMs) {
    return {
      kind: 'rejected',
      reason: 'expired',
      attemptsRemaining: remaining(lock.consecutive_failures),
      retryAfterSeconds: null,
    }
  }

  if (!hashesMatch(hashOtpCode(request.code, challenge.code_salt), challenge.code_hash)) {
    return await recordFailure(uow, request, challenge.id, nowMs)
  }

  await uow.sql`
    update otp_challenge set consumed_at = ${request.nowIso} where id = ${challenge.id}
  `
  // A success clears the counter. Otherwise four honest mistakes followed by a success leaves the
  // number one mistake from a lock, days later, for no reason anybody could explain.
  await uow.sql`
    update otp_phone_lock
    set consecutive_failures = 0, locked_until = null
    where phone_e164 = ${request.phoneE164}
  `
  await uow.audit.record({
    action: 'otp.verified',
    entityType: 'otp_challenge',
    entityId: challenge.id,
    operation: 'update',
    before: { consumed: false },
    after: { consumed: true, phone_e164: request.phoneE164, purpose: request.purpose },
  })
  return { kind: 'verified', challengeId: challenge.id }
}

const remaining = (failures: number): number => Math.max(0, OTP_MAX_FAILED_ATTEMPTS - failures)

async function recordFailure(
  uow: UnitOfWork,
  request: OtpVerifyRequest,
  challengeId: string,
  nowMs: number,
): Promise<OtpVerifyResult> {
  await uow.sql`
    update otp_challenge set failed_attempts = failed_attempts + 1 where id = ${challengeId}
  `
  // One atomic upsert, so two concurrent wrong guesses both count. A read-then-write here would let
  // a parallel attacker get two guesses for the price of one, which is the whole attack.
  const [bumped] = await uow.sql<LockRow[]>`
    insert into otp_phone_lock (phone_e164, consecutive_failures, last_failure_at)
    values (${request.phoneE164}, 1, ${request.nowIso})
    on conflict (phone_e164) do update
      set consecutive_failures = otp_phone_lock.consecutive_failures + 1,
          last_failure_at = ${request.nowIso}
    returning consecutive_failures, locked_until
  `
  const failures = bumped?.consecutive_failures ?? 1

  let lockedUntilMs: number | null = null
  if (failures >= OTP_MAX_FAILED_ATTEMPTS) {
    lockedUntilMs = nowMs + OTP_LOCK_MINUTES * MINUTE_MS
    await uow.sql`
      update otp_phone_lock
      set locked_until = ${isoAt(lockedUntilMs)}
      where phone_e164 = ${request.phoneE164}
    `
    await uow.audit.record({
      action: 'otp.phone_locked',
      entityType: 'otp_phone_lock',
      entityId: request.phoneE164,
      operation: 'update',
      after: {
        phone_e164: request.phoneE164,
        consecutive_failures: failures,
        locked_until: isoAt(lockedUntilMs),
        lock_minutes: OTP_LOCK_MINUTES,
      },
    })
  }

  return {
    kind: 'rejected',
    reason: lockedUntilMs === null ? 'wrong_code' : 'locked',
    attemptsRemaining: remaining(failures),
    retryAfterSeconds:
      lockedUntilMs === null ? null : Math.max(1, Math.ceil((lockedUntilMs - nowMs) / 1000)),
  }
}
