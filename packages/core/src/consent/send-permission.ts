import { AppError, isSendGatingPurpose } from '@berelax/shared'
import type { Instant } from '../time.ts'
import { type ConsentLog, resolveConsent } from './resolve.ts'

/**
 * The bridge from the consent log to the promotional gate's `hasConsent` evaluator (B-MSG-02).
 *
 * `evaluateGate` asks one synchronous question — "does an affirmative consent record exist for this
 * recipient and channel?" — and turns a **throw** into `blocked_unevaluable` and a `false` into
 * `refused_no_consent`. Those are different outcomes with different operational meanings, and the whole
 * value of this module is keeping them apart:
 *
 *   - **`false`** means the store answered and the answer is not a grant. The recipient never opted in,
 *     or opted out. Nothing is wrong; the send is correctly refused.
 *   - **a throw** means the store did not answer *about this recipient at all* — they were not in the
 *     prefetch, so no log was read for them. Nothing here may treat a missing log as "no consent",
 *     because the two are indistinguishable at the call site and only one of them is a bug. A campaign
 *     whose recipient list and whose consent prefetch have drifted apart must stop, loudly, rather than
 *     report a run in which every message was "refused for no consent".
 *
 * ## Why the logs are prefetched rather than looked up here
 *
 * The gate is synchronous, and `packages/core` performs no I/O. So the caller reads every recipient's
 * log in one query (`readConsentLogs` in `@berelax/db`), hands the map in, and this returns the closure
 * the gate calls. A per-message `await` would also mean one round trip per recipient inside the send
 * loop, which is how a 400-contact campaign becomes 400 sequential queries.
 *
 * ## Why the purpose is fixed for the whole evaluator
 *
 * A campaign has one purpose. Taking the purpose per message would mean deriving it from the message —
 * from the template key, in practice — and the template's purpose is not modelled yet (the shipped
 * templates are not seeded; see B-MSG-04's NOTE). A single purpose supplied by the caller is honest
 * about that, and it is refused unless it is one a send may be gated on at all: a `photography` grant is
 * not permission to text somebody an offer, and an evaluator that accepted one would pass every test.
 */

/**
 * The part of an outbound message this evaluator reads.
 *
 * Structural, and deliberately not `OutboundMessage`: `packages/core` may not import
 * `@berelax/messaging` (`core-must-not-import-infrastructure`). The two fields are the two the question
 * is about, and a function taking this shape is assignable to `GateEvaluators.hasConsent` because a
 * parameter type may be widened.
 */
export interface ConsentAskedOf {
  readonly channel: string
  /** E.164 for sms and whatsapp, an address for email. The key the prefetched map is built on. */
  readonly recipient: string
}

export interface ConsentEvaluatorInput {
  /**
   * One log per recipient, keyed exactly as `message.recipient` will spell it.
   *
   * A `Map` rather than a record, because the keys are E.164 numbers and addresses and a plain object
   * would silently answer for `__proto__`, `constructor` and `toString`. `Map.get` does not.
   */
  readonly logs: ReadonlyMap<string, ConsentLog>
  /** The purpose this campaign or flow is gated on. Must be a send-gating purpose. */
  readonly purpose: string
  /** The instant the decision is made at, from the same clock `sendMessage` uses. */
  readonly at: Instant
}

/**
 * Builds the gate's consent evaluator over a prefetched set of logs.
 *
 * The purpose is validated once, when the evaluator is built, rather than on every message: a
 * misconfigured campaign is a configuration error and the configuration is assembled where a deploy or
 * a request fails and somebody is watching. Discovering it on message 200 of 400 would leave the first
 * 199 already sent.
 */
export function consentGateEvaluator(
  input: ConsentEvaluatorInput,
): (message: ConsentAskedOf) => boolean {
  if (!isSendGatingPurpose(input.purpose)) {
    throw new AppError(
      'validation',
      `'${input.purpose}' is not a purpose a promotional send may be gated on. A clinical-processing ` +
        'or photography grant is the lawful basis for holding a record, not permission to message ' +
        'somebody, and a gate built on one would allow every send while looking correct.',
      { details: { purpose: input.purpose } },
    )
  }

  return (message) => {
    const log = input.logs.get(message.recipient)
    if (log === undefined) {
      // A throw, not `false`. See the header: an unread log is not a refusal, and the gate records this
      // as `blocked_unevaluable` with `evaluator: 'consent'` — which names the fault instead of filing
      // it under "this contact never opted in".
      throw new AppError(
        'invariant_violated',
        `No consent log was prefetched for the recipient of this ${message.channel} message. An ` +
          'unread log is not permission and is not a refusal either: the recipient list and the ' +
          'consent prefetch have drifted apart, and the send stops until they agree.',
        { details: { channel: message.channel, purpose: input.purpose } },
      )
    }
    return resolveConsent(log, message.channel, input.purpose, input.at).state === 'granted'
  }
}
