/**
 * The SMSala transport: the one module in the repository that may touch an SMS provider.
 *
 * `.dependency-cruiser.cjs` forbids any import of a provider package from anywhere except
 * `packages/messaging/src/transports/`, and `scripts/test-boundaries.mjs` writes an illegal import
 * and asserts the rule rejects it by name (ADR 0002: a check nobody has seen fail might not be a
 * check). Everything else in the system reaches SMS through `sendMessage`, which is where the
 * sender-ID class rule, the promotional gate and the staging guard are.
 *
 * ## Why one registered identity gets one failure script
 *
 * TDRA registers the two sender IDs separately, and a suspension applies to an *identity*. The fakes
 * take a `FailureScript` per provider instance, so a single shared script would arm every SMS call at
 * once — a promotional suspension would stop booking confirmations, which is precisely the outage two
 * registrations exist to remove (ADR 0016). So each identity gets its own registry handle and its own
 * script, and `failures.promotional.failAlways('rejected')` models the suspension of the promotional
 * identity alone.
 *
 * Both handles share one `CallLog`, because the admin Messages inbox is one inbox.
 *
 * The fake numbers provider message ids per instance, so a transactional and a promotional id can
 * coincide in a test. Nothing in the send path compares ids across identities, and the real SMSala
 * account numbers them itself.
 */
import type { Config } from '@berelax/config'
import {
  type CallLog,
  createCallLog,
  createProviders,
  FailureScript,
  failureModeOf,
  type SmsProvider,
} from '@berelax/providers'
import type { MessageClass } from '../port.ts'
import type {
  ClassRoutedTransport,
  TransportFailure,
  TransportOutcome,
  TransportRequest,
} from '../send.ts'

/**
 * Maps a provider failure onto the vocabulary the choke point records.
 *
 * Takes a plain string rather than the providers' `FailureMode`, so a caller — including this
 * module's test — never needs to import a provider type to reason about the mapping.
 *
 * An unrecognised mode is `provider_error` rather than anything retryable: a failure nobody has
 * classified is not a failure anybody should be automatically retrying.
 */
export function transportFailureFor(failureMode: string | undefined): TransportFailure {
  switch (failureMode) {
    case 'rejected':
      return 'provider_rejected'
    case 'rate_limited':
    case 'quota_exhausted':
      return 'provider_rate_limited'
    case 'timeout':
    case 'server_error':
      return 'provider_unavailable'
    default:
      return 'provider_error'
  }
}

export interface SmsalaTransport {
  readonly transport: ClassRoutedTransport
  /** Every provider call either identity made, in order. The admin inbox and the tests read this. */
  readonly calls: CallLog
  /** One script per registered identity, so a suspension can be armed for one class alone. */
  readonly failures: Readonly<Record<MessageClass, FailureScript>>
}

export function createSmsalaTransport(args: {
  readonly config: Config
  /** Injected, because nothing in this codebase reads the clock directly. */
  readonly now: () => string
}): SmsalaTransport {
  const { config, now } = args
  const calls = createCallLog(now)
  const failures: Record<MessageClass, FailureScript> = {
    transactional: new FailureScript(),
    promotional: new FailureScript(),
  }

  // Selection is configuration, never a code change (docs/12 §1.3): `SMS_PROVIDER=real` resolves to
  // the named real adapter, which throws at construction so a misconfigured deploy fails while
  // somebody is watching rather than sending nothing at 22:00.
  const providers: Record<MessageClass, SmsProvider> = {
    transactional: createProviders({ config, now, log: calls, failures: failures.transactional })
      .sms,
    promotional: createProviders({ config, now, log: calls, failures: failures.promotional }).sms,
  }

  const transport: ClassRoutedTransport = {
    channel: 'sms',
    async send(request: TransportRequest): Promise<TransportOutcome> {
      // Keyed on the SENDER's class, so a forced mismatch reaches the identity it claims to be and
      // is refused by the provider's own sender-ID check — the second line of defence behind
      // `senderIdFor`.
      const provider = providers[request.senderId.messageClass]
      try {
        const accepted = await provider.send({
          recipient: request.message.recipient,
          body: request.message.body,
          senderId: request.senderId,
          messageClass: request.message.messageClass,
          idempotencyKey: request.idempotencyKey,
        })
        return {
          kind: 'accepted',
          providerMessageId: accepted.providerMessageId,
          segments: accepted.segments,
          costFils: accepted.estimatedCostFils,
        }
      } catch (error) {
        return {
          kind: 'failed',
          reason: transportFailureFor(failureModeOf(error)),
          detail: error instanceof Error ? error.message : String(error),
        }
      }
    },
  }

  return { transport, calls, failures }
}
