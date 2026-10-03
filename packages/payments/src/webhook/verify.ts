import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Instant } from '@berelax/core'
import { AppError } from '@berelax/shared'

/**
 * A webhook delivery is an UNAUTHENTICATED REQUEST until its signature verifies.
 *
 * Y-PAY-04. Everything in this module happens before anything else in the request: before `JSON.parse`,
 * before a database connection is opened, before a row is written, and before any log line, breadcrumb or
 * audit payload that could echo the body.
 *
 * ## Why the order is the whole design
 *
 * The body of an unverified delivery is attacker-controlled text that arrives looking exactly like a
 * payment. Three things go wrong if anything touches it first, and all three have been real defects in
 * other systems rather than hypotheticals:
 *
 * - **Parsing first** makes the parser the attack surface, and a parse error becomes a 500 with a stack
 *   trace quoting the body.
 * - **Logging first** copies an unverified payload into a log aggregator that is read by more people than
 *   the database is, and under SAQ-A that body is the one place a misconfigured gateway could put card
 *   data (ADR 0067). {@link verifyWebhookSignature} is handed the raw text and returns no part of it.
 * - **Writing first** — even a "received" row — makes an unauthenticated request able to fill a table.
 *
 * So verification takes the raw bytes as a `string` and a header bag, and returns a discriminated union.
 * The caller cannot reach the body through the refused branch, because the refused branch does not carry
 * it.
 *
 * ## There is no fall-back to trusting the body, and `not_configured` is why
 *
 * No gateway has been chosen (OPEN-QUESTIONS `Y7-gateway`), so `PAYMENT_WEBHOOK_SIGNING_SECRET` is absent
 * by default in every environment. The tempting shape is "verify when a secret is configured", which is a
 * webhook endpoint that trusts every body on a machine where somebody forgot the environment variable —
 * and that machine is production, on the day it is rotated.
 *
 * So the absence of the secret is its own refusal: {@link webhookSigningSecretFrom} answers
 * `not_configured`, and the caller answers **503** rather than 401. The distinction is not pedantry. 401
 * says *your signature is wrong*; the truth is *we cannot check it*. A gateway retries a 503 and gives up
 * on a 401, so answering 401 here would discard events that were perfectly valid, and the endpoint would
 * look healthy while losing money movements.
 *
 * ## Why the timestamp is inside the signature, and why a stale one is a REPLAY
 *
 * The signed payload is `timestamp + '.' + body`, so the timestamp cannot be edited without breaking the
 * MAC. That is what makes a stale delivery distinguishable from a forged one: a correctly signed body
 * whose timestamp is outside the tolerance is a delivery that WAS genuine and is being presented again,
 * which is a different thing from a body somebody wrote.
 *
 * {@link WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS} is **this build's own policy and not a figure read off any
 * vendor's documentation** — there is no vendor. Five minutes is stated here, once, with its reason: it
 * has to be wider than a gateway's own retry jitter and the clock skew between two hosts, and narrower
 * than the window in which a captured delivery is worth replaying. A caller may narrow it; nothing
 * derives it from anything.
 *
 * ## Replay protection is NOT in this module
 *
 * The tolerance window makes a replay *expensive*; it does not make one *impossible*, and a second
 * delivery inside the window is indistinguishable here from the first. That claim belongs to the
 * database — `unique (gateway, event_id)` on `payment_webhook_event`, migration 0147 — because the worker
 * and the web process both restart and a set held in a handler's memory is empty after a deploy. See
 * `./handlers.ts`.
 */

/** Where the gateway's signature and timestamp arrive. Lower-case, as `Headers` normalises them. */
export const WEBHOOK_SIGNATURE_HEADER = 'x-berelax-webhook-signature'
export const WEBHOOK_TIMESTAMP_HEADER = 'x-berelax-webhook-timestamp'

/**
 * How far a delivery's timestamp may be from ours. **This build's policy, not a vendor's.**
 *
 * Wider than a gateway's retry jitter and two hosts' clock skew; narrower than the window in which
 * replaying a captured delivery is worth anything. Stated once, here, and taken as an argument everywhere
 * else so a test can pin it without the module holding two answers.
 */
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300

/** The separator between the timestamp and the body in the signed payload. */
const PAYLOAD_SEPARATOR = '.'

/** 64 lower-case hex characters: the shape of an HMAC-SHA256 digest. */
const SIGNATURE_SHAPE = /^[0-9a-f]{64}$/
/** Up to twelve digits of epoch seconds. Refuses a sign, a fraction and an ISO instant. */
const TIMESTAMP_SHAPE = /^\d{1,12}$/

/**
 * Why a delivery was refused. Every one of these is an answer the endpoint gives without reading the body.
 *
 * `signature_absent` and `signature_malformed` are separate because they have different remedies — one is
 * a caller that is not the gateway at all, the other is a gateway whose format changed — and because the
 * acceptance line asks for all three cases to be asserted individually. `signature_invalid` covers a
 * signature over the wrong payload AND one made with another secret, and that is deliberate: the two are
 * indistinguishable from here by construction, and a scheme that could tell them apart would be leaking
 * which half of the check failed.
 */
export const WEBHOOK_REFUSALS = [
  'secret_not_configured',
  'signature_absent',
  'signature_malformed',
  'signature_invalid',
  'timestamp_outside_tolerance',
] as const
export type WebhookRefusal = (typeof WEBHOOK_REFUSALS)[number]

/**
 * The HTTP status each refusal answers with.
 *
 * Data rather than a `switch`, so the status and the reason have one home and a refusal added to the
 * tuple fails `tsc` here before any test runs.
 *
 * `secret_not_configured` is **503** and every other refusal is **401** — see the module note. The
 * endpoint answers nothing else: there is no 400, because a body this endpoint could not verify is not a
 * body it has read, and "your JSON is malformed" is an answer only a verified caller may have.
 */
export const WEBHOOK_REFUSAL_STATUS: Readonly<Record<WebhookRefusal, 401 | 503>> = Object.freeze({
  secret_not_configured: 503,
  signature_absent: 401,
  signature_malformed: 401,
  signature_invalid: 401,
  timestamp_outside_tolerance: 401,
})

/** The configured secret, or the named absence. */
export type WebhookSigningSecret =
  | { readonly kind: 'configured'; readonly secret: string }
  | { readonly kind: 'not_configured'; readonly missing: readonly string[] }

/**
 * Reads the signing secret out of configuration, naming what is missing when it is not there.
 *
 * Takes the bag rather than calling `loadConfig`, for `hostedFieldsFrom`'s reason: the module stays
 * testable without an environment, and the endpoint builds its runtime once.
 *
 * A blank or whitespace-only value is `not_configured` and not a secret. An empty string is a perfectly
 * valid HMAC key and would verify a signature anybody could compute, so treating it as configured is the
 * fall-back this module exists to refuse — spelled with an environment variable set to nothing, which is
 * what a misconfigured deployment looks like.
 */
export function webhookSigningSecretFrom(config: {
  readonly PAYMENT_WEBHOOK_SIGNING_SECRET?: string | undefined
}): WebhookSigningSecret {
  const secret = config.PAYMENT_WEBHOOK_SIGNING_SECRET
  if (secret === undefined || secret.trim() === '') {
    return { kind: 'not_configured', missing: ['PAYMENT_WEBHOOK_SIGNING_SECRET'] }
  }
  return { kind: 'configured', secret }
}

/** What a verified delivery is: the raw body, and the instant the gateway signed it. */
export interface VerifiedWebhook {
  readonly kind: 'verified'
  /** The raw text, returned only on this branch. A refusal carries no part of the body. */
  readonly body: string
  readonly signedAtEpochSeconds: number
}

export interface RefusedWebhook {
  readonly kind: 'refused'
  readonly reason: WebhookRefusal
  readonly status: 401 | 503
  /** Named for `secret_not_configured`, empty otherwise. Never a fragment of the body. */
  readonly missing: readonly string[]
}

export type WebhookVerification = VerifiedWebhook | RefusedWebhook

const refuse = (reason: WebhookRefusal, missing: readonly string[] = []): RefusedWebhook => ({
  kind: 'refused',
  reason,
  status: WEBHOOK_REFUSAL_STATUS[reason],
  missing,
})

/** The payload a signature covers: the timestamp, a dot, and the body exactly as it arrived. */
export function webhookSignedPayload(timestamp: string, body: string): string {
  return `${timestamp}${PAYLOAD_SEPARATOR}${body}`
}

/**
 * The signature for a payload. Exported because a TEST has to be able to make a correct one.
 *
 * A test that could not sign correctly could only ever assert refusals, and the acceptance line needs the
 * control: a correctly signed delivery must be accepted, or "absent, malformed and wrong-key are refused"
 * is satisfied by an endpoint that refuses everything.
 */
export function signWebhookPayload(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret)
    .update(webhookSignedPayload(timestamp, body), 'utf8')
    .digest('hex')
}

/**
 * Verifies a delivery. The FIRST thing that happens to a webhook request.
 *
 * `headers` is read case-insensitively through the `Headers` API, and `rawBody` is the text exactly as it
 * arrived — re-serialising a parsed object would change the bytes and break every signature, which is the
 * mistake this signature scheme invites and the reason the caller must read `request.text()` and not
 * `request.json()`.
 *
 * `now` is an argument. Nothing here reads a clock, so a test pins the tolerance window instead of
 * sleeping through it.
 */
export function verifyWebhookSignature(input: {
  readonly rawBody: string
  readonly headers: Headers
  readonly secret: WebhookSigningSecret
  readonly now: Instant
  readonly toleranceSeconds?: number
}): WebhookVerification {
  if (input.secret.kind === 'not_configured') {
    return refuse('secret_not_configured', input.secret.missing)
  }

  const signature = input.headers.get(WEBHOOK_SIGNATURE_HEADER)
  const timestamp = input.headers.get(WEBHOOK_TIMESTAMP_HEADER)
  if (signature === null && timestamp === null) return refuse('signature_absent')
  // One header without the other is MALFORMED rather than absent: something signed this request and got
  // the format wrong, which is a different thing to look at from a caller that never tried.
  if (signature === null || timestamp === null) return refuse('signature_malformed')
  if (!SIGNATURE_SHAPE.test(signature) || !TIMESTAMP_SHAPE.test(timestamp)) {
    return refuse('signature_malformed')
  }

  const expected = signWebhookPayload(input.secret.secret, timestamp, input.rawBody)
  /*
    `timingSafeEqual` on the raw bytes, and the hex shape above is what makes it safe to call: it THROWS
    on a length mismatch, so a caller that reached it with an attacker-controlled length would turn a
    forged signature into a 500. `packages/media/src/storage/signing.ts` has the same pairing for the same
    reason.
  */
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))) {
    return refuse('signature_invalid')
  }

  /*
    The tolerance AFTER the MAC, and the order is what makes the two refusals mean anything. Checked first,
    a stale delivery would be rejected as `timestamp_outside_tolerance` whether or not it was ever genuine —
    so an attacker replaying an old body with a fresh timestamp and a forged signature would get the same
    answer as the gateway's own retry, and the log could not tell them apart. Checked second,
    `timestamp_outside_tolerance` means "this was genuinely ours, and it is old", which is a replay.
  */
  const tolerance = input.toleranceSeconds ?? WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
  const signedAtEpochSeconds = Number(timestamp)
  const skewSeconds = Math.abs(Math.floor(input.now / 1000) - signedAtEpochSeconds)
  if (skewSeconds > tolerance) return refuse('timestamp_outside_tolerance')

  return { kind: 'verified', body: input.rawBody, signedAtEpochSeconds }
}

/**
 * The parsed shape of a delivery, AFTER verification.
 *
 * Deliberately not an exhaustive model of anybody's webhook format: no gateway has been chosen, so the
 * fields here are the ones this build needs to move an intent and nothing more, and a delivery carrying
 * extra keys is accepted with them ignored rather than refused — a refusal on an unknown field would make
 * every one of the vendor's future additions an outage.
 */
export interface WebhookDelivery {
  readonly eventId: string
  readonly eventType: string
  readonly gatewayIntentId: string
  /** The gateway's own instant, ISO-8601. What the lifecycle fold orders by. */
  readonly occurredAt: string
  /** Integer fils. Present exactly for the event types that carry an amount. */
  readonly amountFils?: number
}

/** Raised when a VERIFIED body is not a delivery this build can read. */
export class WebhookDeliveryMalformed extends AppError {
  constructor(problem: string) {
    super(
      'validation',
      `WebhookDeliveryMalformed: ${problem}. This body's signature VERIFIED, so it came from the holder ` +
        'of the signing secret — which makes it a format disagreement with the gateway rather than an ' +
        'untrusted request, and the right answer is a refusal that names the field rather than a 401.',
      { details: { problem } },
    )
    this.name = 'WebhookDeliveryMalformed'
  }
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== ''

/**
 * Parses a VERIFIED body. Never called on an unverified one — the type is what enforces that, since it
 * takes a {@link VerifiedWebhook} rather than a string.
 */
export function parseWebhookDelivery(verified: VerifiedWebhook): WebhookDelivery {
  let parsed: unknown
  try {
    parsed = JSON.parse(verified.body)
  } catch {
    // The message carries NO part of the body, even though it verified. A log line is read by more people
    // than the database is, and under SAQ-A this body is the one place a misconfigured gateway could put
    // card data (ADR 0067).
    throw new WebhookDeliveryMalformed('the body is not JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new WebhookDeliveryMalformed('the body is not a JSON object')
  }
  const row = parsed as Record<string, unknown>
  for (const field of ['eventId', 'eventType', 'gatewayIntentId', 'occurredAt'] as const) {
    if (!isNonEmptyString(row[field])) {
      throw new WebhookDeliveryMalformed(`"${field}" is absent or not a non-empty string`)
    }
  }
  const amount = row['amountFils']
  if (amount !== undefined && (typeof amount !== 'number' || !Number.isInteger(amount))) {
    throw new WebhookDeliveryMalformed('"amountFils" is present and is not a whole number of fils')
  }
  const occurredAt = row['occurredAt'] as string
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new WebhookDeliveryMalformed('"occurredAt" is not an instant anything can order by')
  }
  return {
    eventId: row['eventId'] as string,
    eventType: row['eventType'] as string,
    gatewayIntentId: row['gatewayIntentId'] as string,
    occurredAt,
    ...(amount === undefined ? {} : { amountFils: amount as number }),
  }
}
