import { normalisePhoneResult, type PhoneRejection } from '@berelax/core'
import {
  type Actor,
  issueOtpChallenge,
  OTP_CODE_DIGITS,
  OTP_PURPOSES,
  type OtpPurpose,
  type Sql,
  withUnitOfWork,
} from '@berelax/db'
import {
  type ClassifiedTemplate,
  DEFAULT_TEMPLATES,
  type MessageId,
  type SendContext,
  sendMessage,
} from '@berelax/messaging'

/**
 * POST /api/v1/otp — request a one-time code.
 *
 * The logic lives here rather than in `route.ts` so it can be called with its dependencies supplied:
 * a connection, a clock and a send context. `apps/web/src/otp-route.itest.ts` drives this function
 * against a real PostgreSQL and a fake SMSala, which is the only way to measure the one property this
 * endpoint exists to have.
 *
 * ## Enumeration resistance is structural here, not a mitigation
 *
 * A known number and an unknown number must produce the same status, the same body and the same
 * response time. The way that is achieved is not by padding one path to match the other — it is by
 * **not having two paths**. This handler never reads the `customer` table, and neither does
 * `issueOtpChallenge`; `otp_challenge.phone_e164` is deliberately not a foreign key. The code is
 * issued and sent for any well-formed mobile number, whether or not the business has ever seen it.
 *
 * Two consequences are worth stating because they look like defects and are not:
 *
 *   - an SMS goes to a number that is not a customer. That is what the per-number and per-IP rate
 *     limits are for, and the alternative — silently not sending — is the branch that tells an
 *     attacker which numbers are customers, at a thousand numbers a minute.
 *   - the response says "sent" without saying whether the number exists, so the UI cannot show "no
 *     account found". There is no account to find (ADR 0014); the next screen asks for the code.
 *
 * ## The send goes through the choke point
 *
 * `sendMessage` is the only way out. It resolves the sender identity from the template class, runs the
 * promotional gate, applies the campaign cap and then the staging guard — so outside production this
 * code lands in the local outbox instead of a real handset, and `auth.otp` leaves from the
 * transactional sender ID whatever else is going on with marketing. Nothing here touches a provider,
 * and `.dependency-cruiser.cjs` rejects the import that would.
 */

/** The body this endpoint accepts. Anything else is a 400, before any work is done. */
export interface OtpRequestBody {
  readonly phone?: unknown
  readonly purpose?: unknown
  readonly locale?: unknown
}

export interface OtpEndpointDeps {
  readonly sql: Sql
  /** Injected, so the integration suite can freeze it. */
  readonly now: () => string
  readonly send: SendContext
}

/** Every reason this endpoint refuses, as a value. The UI branches on these, never on prose. */
export const OTP_ENDPOINT_ERRORS = [
  'invalid_request',
  'phone_not_eligible',
  'too_many_requests',
  'send_failed',
] as const
export type OtpEndpointError = (typeof OTP_ENDPOINT_ERRORS)[number]

/**
 * The actor on a public OTP request.
 *
 * `customer` rather than `system`, with no id: the request is made on a customer's behalf and the
 * audit trail should say so, but nobody has proved who they are yet — that is what the code is for.
 * A label rather than a name, because this system invents no names for people.
 */
const CALLER: Actor = { kind: 'customer', label: 'OTP request (unauthenticated)' }

/** The shipped `auth.otp` template, resolved by key and locale. */
function otpTemplate(locale: 'en' | 'ar'): ClassifiedTemplate {
  const found = DEFAULT_TEMPLATES.find(
    (template) => template.key === 'auth.otp' && template.locale === locale,
  )
  if (found === undefined) {
    throw new Error(
      `No auth.otp template for locale ${locale}. The send path has nothing to render.`,
    )
  }
  return found
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // A code request is never cacheable and never shared. Said explicitly because a CDN in front of
      // this route with a default policy would serve one customer's rate-limit refusal to another.
      'cache-control': 'no-store',
      ...headers,
    },
  })

/**
 * Reads the caller address from the proxy headers, or returns null.
 *
 * Validated rather than trusted: `request_ip` is an `inet` column, and a header of free text would
 * either raise on insert or — worse, if the column were text — split the per-IP bucket per spelling.
 * Null when there is nothing usable, because a placeholder address would put every such request in
 * one bucket and rate-limit them as if they were one caller.
 */
export function callerAddress(headers: Headers): string | null {
  const forwarded = headers.get('x-forwarded-for') ?? headers.get('x-real-ip')
  if (forwarded === null) return null
  const first = forwarded.split(',')[0]?.trim() ?? ''
  const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/
  const ipv6 = /^[0-9a-f:]{2,45}$/i
  if (ipv4.test(first) || ipv6.test(first)) return first
  return null
}

interface ParsedRequest {
  readonly phone: string
  readonly purpose: OtpPurpose
  readonly locale: 'en' | 'ar'
}

/**
 * Reads the body, refusing anything unexpected rather than defaulting it.
 *
 * An unrecognised `purpose` is a 400 and not a silent fall back to `booking_verify`: the purpose is
 * what stops a code issued to confirm a booking being replayed to read clinical flags, and a typo that
 * quietly becomes the weakest purpose is the wrong direction for that to fail in.
 *
 * The length cap is on the phone field because it reaches a regex. 32 characters is more than any
 * spelling of an E.164 number needs, separators and all.
 */
function readBody(body: unknown): ParsedRequest | null {
  if (typeof body !== 'object' || body === null) return null
  const { phone, purpose, locale } = body as OtpRequestBody
  if (typeof phone !== 'string' || phone.length === 0 || phone.length > 32) return null
  if (purpose !== undefined && !(OTP_PURPOSES as readonly string[]).includes(String(purpose))) {
    return null
  }
  if (locale !== undefined && locale !== 'en' && locale !== 'ar') return null
  return {
    phone,
    purpose: purpose === undefined ? 'booking_verify' : (purpose as OtpPurpose),
    locale: locale === 'ar' ? 'ar' : 'en',
  }
}

export async function handleOtpRequest(deps: OtpEndpointDeps, request: Request): Promise<Response> {
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return json(400, { error: 'invalid_request' satisfies OtpEndpointError })
  }
  const parsed = readBody(raw)
  if (parsed === null) return json(400, { error: 'invalid_request' satisfies OtpEndpointError })

  const normalised = normalisePhoneResult(parsed.phone)
  if (!normalised.ok) {
    // 422 and the named reason: the number was understood and refused, which is a different thing
    // from a malformed request and needs a different message on screen. A landline gets
    // `landline_not_an_sms_target` and the form can say so instead of "invalid".
    return json(422, {
      error: 'phone_not_eligible' satisfies OtpEndpointError,
      reason: normalised.reason satisfies PhoneRejection,
    })
  }

  const nowIso = deps.now()
  const requestIp = callerAddress(request.headers)
  const requestId = request.headers.get('x-request-id')
  const outcome = await withUnitOfWork(
    deps.sql,
    CALLER,
    (uow) =>
      issueOtpChallenge(uow, {
        phoneE164: normalised.e164,
        purpose: parsed.purpose,
        nowIso,
        requestIp,
        requestId,
      }),
    // Spread rather than assigned: `exactOptionalPropertyTypes` makes an explicit `undefined`
    // different from an absent key, and the audit context means "unknown" by absence.
    {
      ...(requestIp === null ? {} : { ipAddress: requestIp }),
      ...(requestId === null ? {} : { requestId }),
    },
  )

  if (outcome.kind !== 'issued') {
    // Both limits and the lock answer 429 with `Retry-After`, which is what a well-behaved client
    // waits on. The reason is included because the remedies differ: one is "wait", the other is
    // "you have run out of guesses".
    return json(
      429,
      {
        error: 'too_many_requests' satisfies OtpEndpointError,
        reason: outcome.kind === 'locked' ? 'temporarily_locked' : 'rate_limited',
        retryAfterSeconds: outcome.retryAfterSeconds,
      },
      { 'retry-after': String(outcome.retryAfterSeconds) },
    )
  }

  // The send happens AFTER the challenge transaction has committed, not inside it. An SMS inside a
  // transaction that later rolls back is a code in somebody's hand for a challenge that does not
  // exist — unverifiable, and indistinguishable from a broken system. This way round, the worst case
  // is a challenge nobody can use and a 502 telling the customer to try again.
  const template = otpTemplate(parsed.locale)
  const result = await sendMessage(deps.send, {
    // Derived from the challenge, so a retry of the same challenge cannot be billed twice: the
    // idempotency key the choke point builds is `auth.otp:otp-<challenge id>`.
    id: `otp-${outcome.challengeId}` as MessageId,
    template,
    values: { code: outcome.code, minutes: String(Math.round(outcome.ttlSeconds / 60)) },
    recipient: normalised.e164,
  })

  if (result.kind === 'failed' || result.kind === 'blocked') {
    // Reported rather than swallowed. "Sent" when nothing left the building is how a customer ends up
    // staring at a phone for five minutes; the status does not depend on whether the number is a
    // customer, so it leaks nothing.
    return json(502, { error: 'send_failed' satisfies OtpEndpointError, reason: result.reason })
  }

  // The one success body, byte for byte, for every number. No id, no name, no "welcome back": the
  // response must not be a lookup oracle. `codeLength` is here because the input needs to know how
  // many boxes to draw, and it is the same for everybody.
  return json(202, {
    status: 'sent',
    expiresInSeconds: outcome.ttlSeconds,
    codeLength: OTP_CODE_DIGITS,
  })
}
