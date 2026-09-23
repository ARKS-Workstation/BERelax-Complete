/**
 * Sender identities, and the total routing table from (message_class × channel) to one of them.
 *
 * ## Why this is a module and not a string field
 *
 * TDRA registers a sender *identity*, and a suspension applies to an identity rather than to an account.
 * That is the whole reason there are two: one over-eager promotional blast suspends the identity it left
 * from, and if that identity is also the one booking confirmations, reminders and OTPs leave from, a
 * marketing mistake has become an operational outage (ADR 0016, docs/04 §5).
 *
 * A `senderId: string` on a send call cannot carry any of that. It cannot say which class of traffic the
 * identity is registered for, so nothing can refuse the pairing; it cannot say which channel it belongs
 * to, so an SMS alphanumeric ends up on an email row; and it cannot say "not registered", so the only
 * available answer for an unconfigured channel is some other channel's value. So an identity here is a
 * record carrying its class, and the *table* is what maps a message onto one.
 *
 * ## Why the table is total, and what "total" means here
 *
 * `SENDER_IDENTITY_ROUTES` has an entry for every one of the six (class × channel) pairs, and
 * `satisfies Record<MessageClass, Record<Channel, SenderIdentityRoute>>` is what makes a seventh pair —
 * a fourth channel, a third class — fail to compile rather than fall into a `default`. Every pair
 * therefore has exactly ONE answer, and the answer for a pair with no registration is a typed refusal.
 *
 * That is the property worth having. The alternative, and the one this replaces, was a lookup keyed on
 * the class alone: `senderIdFor(registry, 'transactional')` answers `BERELAX` for an EMAIL message just
 * as happily as for an SMS, and `deliverMessage` then wrote an SMS alphanumeric into the `sender_id`
 * column of an email row — a column whose own comment in migration 0035 says "null for email, which has
 * a from-address rather than a TDRA registration". Nothing failed; the row was simply wrong, for months.
 *
 * ## The three kinds of answer, and why `delegated` is not a fallback
 *
 *   - **`registered`** — SMS. Two TDRA registrations, one per class, and the value goes on the wire and
 *     onto the `message` row.
 *   - **`delegated`** — email. The identity is the verified sending subdomain the transport was
 *     configured with, not something the choke point selects: docs/05 §2 asks for separate transactional
 *     and marketing subdomains, neither exists (`Y6-email-sender`), and `createResendTransport` therefore
 *     takes its `from` as a required argument with no default. The resolution says so, the row stores
 *     `null`, and nothing is invented. This is a *declared* answer about a channel, not a fallback to
 *     another pair's value: no identity is borrowed and none is guessed.
 *   - **`refused`** — WhatsApp. No vendor is contracted for the channel at all (`vendorFor` refuses it),
 *     so there is no identity to send from and the send stops. Fail closed, by the definition that
 *     matters: the refusal is returned, typed, and the transport is never reached.
 *
 * ## Why a misconfigured registry is refused rather than corrected
 *
 * {@link resolveSenderIdentity} returns a refusal when the registry slot it reads disagrees with the
 * pair — the transactional slot holding an `AD-` value, the promotional slot holding a value registered
 * as transactional, one value in both slots. It does not pick the other slot, reorder them or strip the
 * prefix. A send that silently falls back to the other identity is a promotional message going out under
 * a transactional sender ID, which is the one outcome this module exists to make impossible.
 */
import { AppError, type MessageClass } from '@berelax/shared'
import type { Channel } from './port.ts'

/** Promotional identities are registered with an `AD-` prefix; transactional ones must not carry it. */
export const PROMOTIONAL_SENDER_PREFIX = 'AD-'

/** A TDRA-registered sender identity, and the one class of traffic it may carry. */
export interface SenderIdentity {
  readonly value: string
  readonly messageClass: MessageClass
}

/**
 * The two SMS registrations.
 *
 * Two, not one, and separately registered: with a single identity one over-eager blast suspends it and
 * every booking confirmation, reminder and OTP stops with it. See ADR 0016 and docs/04 §5.
 */
export interface SenderIdRegistry {
  readonly transactional: SenderIdentity
  readonly promotional: SenderIdentity
}

/**
 * Checks a registry at the point it is built, rather than at the point a message needs it.
 *
 * A misconfigured registry is a configuration error, and the configuration is read at boot where a
 * deploy fails and somebody is watching. Discovering it on the 9pm reminder run instead means the first
 * symptom is a rejected send.
 */
export function assertSenderIdRegistry(registry: SenderIdRegistry): SenderIdRegistry {
  const fault = senderIdRegistryFault(registry)
  if (fault !== null) {
    throw new AppError('invariant_violated', fault.detail, {
      details: { fault: fault.fault, registry },
    })
  }
  return registry
}

/** Why a registry may not be used. One value per fault, so a caller branches on it and not on prose. */
export type SenderIdRegistryFault =
  | 'slot_class_disagrees'
  | 'one_identity_for_both_classes'
  | 'promotional_missing_ad_prefix'
  | 'transactional_carries_ad_prefix'

/**
 * The first fault in a registry, or `null`.
 *
 * Split out of {@link assertSenderIdRegistry} so {@link resolveSenderIdentity} can *refuse* rather than
 * throw: the choke point returns a result for every outcome, and a throw there would make each caller —
 * a worker, a route handler, a flow interpreter — invent its own answer to "did that message go out?".
 */
export function senderIdRegistryFault(
  registry: SenderIdRegistry,
): { readonly fault: SenderIdRegistryFault; readonly detail: string } | null {
  for (const messageClass of ['transactional', 'promotional'] as const) {
    const identity = registry[messageClass]
    if (identity.messageClass !== messageClass) {
      return {
        fault: 'slot_class_disagrees',
        detail:
          `The ${messageClass} sender ID '${identity.value}' is registered as ` +
          `${identity.messageClass}. A registry whose slots and classes disagree routes one class of ` +
          'traffic out of the other identity, which is the send that gets a sender ID suspended.',
      }
    }
  }

  // Checked before the prefix rules, and not after: one identity used for both classes always trips one
  // prefix rule or the other, so reporting the prefix would send somebody off to rename a sender ID when
  // the actual fault is that only one was ever registered.
  if (registry.transactional.value === registry.promotional.value) {
    return {
      fault: 'one_identity_for_both_classes',
      detail:
        `Both classes are registered to '${registry.transactional.value}'. One identity means a ` +
        'promotional suspension takes every booking confirmation and OTP with it — the outage two ' +
        'registrations exist to remove.',
    }
  }

  if (!registry.promotional.value.startsWith(PROMOTIONAL_SENDER_PREFIX)) {
    return {
      fault: 'promotional_missing_ad_prefix',
      detail:
        `The promotional sender ID '${registry.promotional.value}' must carry the ` +
        `'${PROMOTIONAL_SENDER_PREFIX}' prefix TDRA registers promotional identities under.`,
    }
  }

  if (registry.transactional.value.startsWith(PROMOTIONAL_SENDER_PREFIX)) {
    return {
      fault: 'transactional_carries_ad_prefix',
      detail:
        `The transactional sender ID '${registry.transactional.value}' must not carry the ` +
        `'${PROMOTIONAL_SENDER_PREFIX}' prefix. A booking confirmation that arrives looking like an ` +
        'advert is what customers block.',
    }
  }

  return null
}

/**
 * The registrations the build assumed, validated at import.
 *
 * Provisional: the real values are `Y6-sender-ids` in docs/OPEN-QUESTIONS.md, and registration is an
 * external dependency with a lead time (docs/05). They are a single constant so correcting them is one
 * edit, and `assertSenderIdRegistry` runs here so a wrong pair fails at boot rather than at 9pm.
 */
export const PROVISIONAL_SENDER_IDS: SenderIdRegistry = assertSenderIdRegistry({
  transactional: { value: 'BERELAX', messageClass: 'transactional' },
  promotional: { value: 'AD-BERELAX', messageClass: 'promotional' },
})

/**
 * The identity for a class, from the SMS registry. Throws on a registry that may not be used.
 *
 * Kept because it is the narrow question the SMS transport and its conformance tests ask, and because
 * `assertSenderIdRegistry` has already made a bad registry unconstructible at boot. Every SEND goes
 * through {@link resolveSenderIdentity} instead, which knows about channels and returns a refusal.
 */
export function senderIdFor(
  registry: SenderIdRegistry,
  messageClass: MessageClass,
): SenderIdentity {
  const identity = registry[messageClass]
  if (identity.messageClass !== messageClass) {
    throw new AppError(
      'invariant_violated',
      `The ${messageClass} slot holds '${identity.value}', which is registered as ` +
        `${identity.messageClass}. Refusing to send rather than sending from the wrong identity.`,
      { details: { messageClass, identity } },
    )
  }
  return identity
}

// --- the routing table --------------------------------------------------------------------------

/** How a (class, channel) pair gets its identity. One of exactly three, per pair, declared. */
export type SenderIdentityRoute =
  /** From the TDRA registry in this module. SMS. */
  | 'registered'
  /** From the transport's own verified sending address. Email. See the header. */
  | 'delegated'
  /** No identity exists for this pair. The send is refused. WhatsApp. */
  | 'unregistered'

/**
 * The table, total over (message_class × channel).
 *
 * Written out per class rather than derived from the channel, although both rows are currently identical,
 * and that is deliberate: the day a second email sending subdomain is verified, the promotional row's
 * `email` cell becomes `registered` and the transactional one does not, and a derived table would have no
 * place to say so. The `satisfies` is what refuses a fourth channel or a third class silently defaulting.
 */
export const SENDER_IDENTITY_ROUTES = {
  transactional: {
    sms: 'registered',
    // Y6-email-sender. `createResendTransport` takes its `from` as a required argument with no default,
    // and inventing an address here would be worse than a blank one (brief rule 15).
    email: 'delegated',
    // ADR 0016: the channel exists in the schema and the vendor does not. `vendorFor('whatsapp')`
    // refuses for the same reason.
    whatsapp: 'unregistered',
  },
  promotional: {
    sms: 'registered',
    email: 'delegated',
    whatsapp: 'unregistered',
  },
} as const satisfies Record<MessageClass, Record<Channel, SenderIdentityRoute>>

/** Why no identity could be produced. Typed, because "blocked" without the reason is unactionable. */
export type SenderIdentityRefusal =
  /** The pair has no registration at all. WhatsApp today. */
  | 'sender_identity_not_registered'
  /** The pair has one and the registry cannot be used. Never falls back to the other slot. */
  | 'sender_id_class_mismatch'

export type SenderIdentityResolution =
  | { readonly kind: 'identity'; readonly identity: SenderIdentity }
  /**
   * The channel's identity belongs to its transport, and the `message` row stores `null` for it.
   * A declared answer about a channel, not a fallback to another pair's value.
   */
  | { readonly kind: 'delegated'; readonly channel: Channel; readonly detail: string }
  | {
      readonly kind: 'refused'
      readonly reason: SenderIdentityRefusal
      readonly messageClass: MessageClass
      readonly channel: Channel
      readonly detail: string
    }

/**
 * The identity a message leaves from. The only way one is ever chosen.
 *
 * Takes the class and the channel and nothing else — in particular no call-site preference, which is why
 * `SendRequest` has no `senderId` field and fences one out at the type level.
 */
export function resolveSenderIdentity(
  registry: SenderIdRegistry,
  message: { readonly messageClass: MessageClass; readonly channel: Channel },
): SenderIdentityResolution {
  const { messageClass, channel } = message
  const route: SenderIdentityRoute = SENDER_IDENTITY_ROUTES[messageClass][channel]

  if (route === 'unregistered') {
    return {
      kind: 'refused',
      reason: 'sender_identity_not_registered',
      messageClass,
      channel,
      detail:
        `No sender identity is registered for ${messageClass} ${channel}. Refusing the send rather ` +
        "than borrowing another channel's identity: a message that leaves from an identity it was not " +
        'registered under is the send that gets that identity suspended.',
    }
  }

  if (route === 'delegated') {
    return {
      kind: 'delegated',
      channel,
      detail:
        `${channel} leaves from the verified sending address its transport was configured with, not ` +
        'from a registered sender identity this table holds (docs/05 §2, Y6-email-sender). The ' +
        'message row records no sender_id for it.',
    }
  }

  // `registered`. The registry is consulted, and a registry that may not be used is a refusal rather
  // than a correction — see the header.
  const fault = senderIdRegistryFault(registry)
  if (fault !== null) {
    return {
      kind: 'refused',
      reason: 'sender_id_class_mismatch',
      messageClass,
      channel,
      detail: fault.detail,
    }
  }

  return { kind: 'identity', identity: registry[messageClass] }
}
