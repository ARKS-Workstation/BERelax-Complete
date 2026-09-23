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
 * ## The provider message id is the vendor's own, unqualified
 *
 * It was tempting to qualify it here with the message class, because this transport holds two provider
 * instances and the fake used to number them per instance — so `smsala-000001` could be issued twice.
 * That was the wrong place to fix it: `message.provider_message_id` is persisted, it is matched against
 * incoming delivery receipts, and it is the string somebody quotes at SMSala support. A prefix this
 * system invented would be an id the vendor never issued. The fake was fixed instead, and derives the id
 * from the idempotency key — stable for one message, distinct for two, in any process.
 */
import type { Config } from '@berelax/config'
import {
  type CallLog,
  createCallLog,
  createProviders,
  type DeliveryStatus,
  FailureScript,
  failureModeOf,
  type SmsProvider,
} from '@berelax/providers'
import type { MessageStatus } from '@berelax/shared'
import type { DeliveryReceiptRecord, ReceiptSource } from '../lifecycle.ts'
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

/**
 * SMSala's delivery vocabulary, mapped onto ours. Exhaustive by construction.
 *
 * `satisfies Record<DeliveryStatus, MessageStatus>` is the point: `DeliveryStatus` is the vendor's
 * union in `packages/providers/src/sms/port.ts`, so the day SMSala grows a sixth status this stops
 * compiling and somebody decides what it means. A `switch` with a `default` would have swallowed it.
 *
 * `expired` and `rejected` both become `failed` and both keep their own word in
 * `message_delivery_receipt.vendor_status`: they are the same fact for the lifecycle — the message did
 * not arrive — and different facts for an operator, because an expiry is a handset that was off for
 * 48 hours and a rejection is a number that will never work.
 */
export const SMSALA_STATUS_MAP = {
  accepted: 'sent',
  delivered: 'delivered',
  failed: 'failed',
  expired: 'failed',
  rejected: 'failed',
} as const satisfies Record<DeliveryStatus, MessageStatus>

/**
 * One SMSala status word, mapped.
 *
 * `null` for anything else, and that is the answer the acceptance criterion turns on: an unrecognised
 * vendor status must not become `delivered`. It is recorded with the vendor's word intact and
 * `ignored_reason = 'vendor_status_unrecognised'`, so a vocabulary change shows up as a queue of
 * receipts nobody applied rather than as a wall of messages reported as delivered.
 *
 * Takes a `string` rather than `DeliveryStatus` on purpose: the argument comes off the wire, and typing
 * it as the union would mean the only way to reach this function is to have already assumed the answer.
 */
export function mapSmsalaStatus(vendorStatus: string): MessageStatus | null {
  return Object.hasOwn(SMSALA_STATUS_MAP, vendorStatus)
    ? SMSALA_STATUS_MAP[vendorStatus as DeliveryStatus]
    : null
}

export interface SmsalaTransport {
  readonly transport: ClassRoutedTransport
  /** Every provider call either identity made, in order. The admin inbox and the tests read this. */
  readonly calls: CallLog
  /** One script per registered identity, so a suspension can be armed for one class alone. */
  readonly failures: Readonly<Record<MessageClass, FailureScript>>
  /** The delivery receipts both identities have reported since the last drain, already mapped. */
  readonly receipts: ReceiptSource
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
      const identity = request.senderId
      if (identity === null) {
        // `TransportRequest.senderId` is nullable because email's identity belongs to its transport
        // (`SENDER_IDENTITY_ROUTES` answers `delegated`). SMS's does not: an alphanumeric sender ID is a
        // TDRA registration, every SMS leaves from one, and a message with no resolved identity must not
        // reach the vendor to have one chosen for it. Unreachable through `sendMessage`, which refuses
        // first — and refused here as well, because this transport can also be called directly by a test.
        return {
          kind: 'failed',
          reason: 'provider_rejected',
          detail:
            'An SMS reached the SMSala transport with no resolved sender identity. Every SMS leaves ' +
            'from a registered identity and the choke point chooses it; sending without one would let ' +
            'the vendor pick, which is how promotional traffic leaves under a transactional ' +
            'registration.',
        }
      }
      // Keyed on the SENDER's class, so a forced mismatch reaches the identity it claims to be and
      // is refused by the provider's own sender-ID check — the second line of defence behind
      // `resolveSenderIdentity`.
      const provider = providers[identity.messageClass]
      try {
        const accepted = await provider.send({
          recipient: request.message.recipient,
          body: request.message.body,
          senderId: identity,
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

  const receipts: ReceiptSource = {
    vendor: 'smsala',
    async drain(): Promise<readonly DeliveryReceiptRecord[]> {
      const drained: DeliveryReceiptRecord[] = []
      // Both identities, in a declared order rather than `Object.values`: the promotional identity's
      // receipts and the transactional identity's are two queues, and a drain that read one of them
      // would leave the other growing silently until a suspension test noticed.
      for (const messageClass of ['transactional', 'promotional'] as const) {
        for (const receipt of await providers[messageClass].drainDeliveryReceipts()) {
          drained.push({
            vendor: 'smsala',
            providerMessageId: receipt.providerMessageId,
            vendorStatus: receipt.status,
            mapped: mapSmsalaStatus(receipt.status),
            occurredAtIso: receipt.occurredAtIso,
            reason: receipt.reason ?? null,
          })
        }
      }
      return drained
    },
  }

  return { transport, calls, failures, receipts }
}
