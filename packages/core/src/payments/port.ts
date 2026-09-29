import type { Brand } from '@berelax/shared'
import type { TenderKind } from '../checkout/posting.ts'
import type { AccountCode } from '../ledger/account.ts'
import type { Money } from '../money.ts'
import type { Clock, Instant } from '../time.ts'
import type { MinorUnitConvention } from './minor-units.ts'
import type { PaymentIntentEvent, PaymentIntentState } from './state.ts'

/**
 * The PaymentGateway port: types only, and every amount is integer-fils {@link Money}.
 *
 * ADR 0022 says every external service is a port with a fake that fails on demand, and ADR 0055 says
 * what makes something an *adapter* rather than a module that happens to compile: the conformance suite
 * in `@berelax/payments/conformance` accepts it. Nothing here is an implementation, and nothing here
 * reads a clock — the {@link PaymentGatewayDependencies} an adapter is constructed with carries one, and
 * the suite's `every-instant-comes-from-the-injected-clock` rule is what makes that load-bearing rather
 * than a convention.
 *
 * ## Why the instrument is a `TenderKind` and not a new word
 *
 * M-TILL-07 built the tender-type registry (`@berelax/core/money/tender.ts`) with
 * `TENDER_ADAPTERS = ['manual', 'gateway']` and said of the `adapter` column: *"All three are `manual`
 * today, which is the honest answer: the gateway does not exist. This is the column Y-PAY's types will
 * differ on."* So the vocabulary already exists and already has a posting account per entry. A second
 * enumeration here — `PaymentMethod`, `Instrument`, anything — would be a second answer to "where does
 * card money go", and the first symptom of a disagreement is a bank reconciliation that is out by every
 * gateway batch. Migration 0105 adds the fourth kind, `card_online`, which is the one this port needed
 * and the till never had.
 *
 * ## Why money is never a number on this surface
 *
 * Every request and every result carries `Money`, which is `{ fils, currency }` with `fils` branded.
 * A gateway on another minor-unit convention converts at its own edge with
 * {@link MinorUnitConvention} and {@link module:minor-units}, and a plain `number` never crosses this
 * boundary in either direction. `packages/payments/src/port-types.test.ts` asserts the compile-time half
 * — a float literal, and a bare number where `Money` is wanted, are both type errors.
 */

export type GatewayName = Brand<string, 'GatewayName'>
export type GatewayIntentId = Brand<string, 'GatewayIntentId'>
export type IdempotencyKey = Brand<string, 'IdempotencyKey'>

/**
 * Where an event stream is resumed from.
 *
 * Opaque on purpose: a cursor is the gateway's own bookmark and a consumer that parsed it — as a
 * timestamp, as a sequence number — would break the day a gateway changed its shape. `null` means "from
 * the beginning", which is what Y-PAY-05's first reconciliation run has.
 */
export type GatewayEventCursor = Brand<string, 'GatewayEventCursor'>

/** What a gateway is asked to reserve. */
export interface AuthoriseRequest {
  readonly amount: Money
  readonly instrument: TenderKind
  /**
   * The caller's key for this attempt. A second call with the same key returns the first answer and
   * moves no money — asserted for every adapter by the suite's
   * `idempotency-key-replays-the-first-answer` rule.
   *
   * A key identifies ONE call: not one intent, and not one operation. A caller draws a fresh key per attempt
   * and never reuses one across intents, and an adapter handed a reused key refuses with
   * `IdempotencyKeyReusedAcrossIntents` rather than answering with the intent it remembers — because that
   * answer would report one document's figures as another's.
   */
  readonly idempotencyKey: IdempotencyKey
  /** The invoice or booking this belongs to, carried through to reconciliation. */
  readonly reference: string
}

export interface CaptureRequest {
  readonly gatewayIntentId: GatewayIntentId
  readonly amount: Money
  readonly idempotencyKey: IdempotencyKey
}

export interface RefundRequest {
  readonly gatewayIntentId: GatewayIntentId
  readonly amount: Money
  readonly idempotencyKey: IdempotencyKey
  /** Why. Stored, because a refund with no reason cannot be answered to an auditor. */
  readonly reason: string
}

export interface VoidRequest {
  readonly gatewayIntentId: GatewayIntentId
  readonly idempotencyKey: IdempotencyKey
}

/** What the gateway says an intent is, right now. Every figure integer fils. */
export interface GatewayIntentSnapshot {
  readonly gatewayIntentId: GatewayIntentId
  readonly state: PaymentIntentState
  readonly instrument: TenderKind
  /**
   * Where a tender of this instrument is debited, snapshotted from the tender registry.
   *
   * On the snapshot rather than looked up by the consumer for `payment.posting_account_code`'s reason:
   * re-mapping an instrument's account in two years must not restate a posting already filed.
   */
  readonly postingAccountCode: AccountCode
  readonly authorised: Money
  readonly captured: Money
  readonly refunded: Money
  /** From the injected clock. Never the adapter's own. */
  readonly observedAt: Instant
  /** Where the customer completes a challenge. Present only in `requires_customer_action`. */
  readonly customerActionUrl?: string
}

/** One refund, as the gateway acknowledged it. */
export interface GatewayRefundReceipt {
  readonly refundId: string
  readonly gatewayIntentId: GatewayIntentId
  readonly amount: Money
  readonly acknowledgedAt: Instant
}

/** An event read from a gateway, with the cursor that would resume after it. */
export interface GatewayEventDelivery {
  readonly event: PaymentIntentEvent
  readonly gatewayIntentId: GatewayIntentId
  readonly cursor: GatewayEventCursor
}

export const GATEWAY_OPERATIONS = ['authorise', 'capture', 'refund', 'void'] as const
export type GatewayOperation = (typeof GATEWAY_OPERATIONS)[number]

/**
 * The record an adapter writes before it returns, and the reason the port has a sink at all.
 *
 * ADR 0022 rule 1: *no fake returns success without writing to a visible call log*, because a stub that
 * returns `{ ok: true }` makes a broken system demo perfectly. This is the payments-shaped version of
 * that log, and it carries the two things a call log does not: the posting account the movement will be
 * journalled to, and the amount in fils. So the record is simultaneously the operator-visible outbox row
 * and everything Y-PAY-02 needs to write a `payment` row from — which is why an adapter that returns
 * success without writing one fails a named conformance case rather than passing a demo.
 */
export interface GatewayMovementRecord {
  readonly gateway: GatewayName
  readonly operation: GatewayOperation
  readonly gatewayIntentId: GatewayIntentId
  readonly instrument: TenderKind
  readonly postingAccountCode: AccountCode
  /**
   * What the call was for, in fils. Zero for a void, which releases a reservation and moves nothing.
   *
   * Deliberately the amount of the REQUEST rather than the amount that ended up moving. A declined
   * authorisation records what was attempted, because a row that read zero would be indistinguishable from
   * a call nobody made — and "did the money move" is answered by the intent's state, where it has one
   * home, rather than by a second figure here that could disagree with it.
   */
  readonly amount: Money
  /** What an operator reads on the payments screen. A blank one is a blank row, which is the same lie. */
  readonly summary: string
  /** From the injected clock. */
  readonly occurredAt: Instant
  readonly idempotencyKey: IdempotencyKey
  /** Set when this call was suppressed as a duplicate, so a replay is visible rather than invisible. */
  readonly suppressedDuplicate?: boolean
}

/** Where movement records go. The admin payments screen and the conformance suite both read one. */
export interface PaymentRecordSink {
  record(movement: GatewayMovementRecord): void
  /** In call order. */
  all(): readonly GatewayMovementRecord[]
}

/**
 * What an adapter can and cannot do.
 *
 * **Every `false` here is a refusal the suite demands, never a rule the adapter skips.** That inversion
 * is the whole design: a capability flag that merely turned a case off would be the way an adapter opted
 * out of the contract, and the first adapter to do it would be the real one, in production, on the path
 * nobody had exercised. So `supportsPartialRefund: false` means the suite requires a partial refund to be
 * REFUSED with a named error; `emitsEvents: false` means it requires the event stream to be empty after a
 * capture that would have produced one; `hasExternalService: false` means it requires an armed failure to
 * change nothing. A dishonest flag fails a case in one direction or the other.
 */
export interface GatewayCapabilities {
  /**
   * Does this gateway have an asynchronous event stream at all? Cash does not settle later.
   *
   * There is deliberately no `settlesImmediately` here. Whether the money is in hand is a property of the
   * INSTRUMENT and `tender_type.settles_immediately` already answers it — cash is in the drawer, a card
   * batch is not — and one gateway serves instruments that differ on it. A second answer at gateway
   * granularity could only be a coarser, wronger copy of the registry's.
   */
  readonly emitsEvents: boolean
  /** May a capture take less than was authorised? */
  readonly supportsPartialCapture: boolean
  /** May a refund return less than was captured? A spa refunds one treatment out of three. */
  readonly supportsPartialRefund: boolean
  /** May an authorisation be released without capturing? */
  readonly supportsVoid: boolean
  /**
   * Is there an external service that can fail?
   *
   * False for the till: the customer is standing at the desk with the money, and there is nothing to
   * call. ADR 0022's *"the one adapter that is not a fake"*.
   */
  readonly hasExternalService: boolean
}

/**
 * Everything an adapter is given. Constructed by the registry and by the conformance suite, nobody else.
 *
 * The `clock` is here rather than read inside an adapter because the conformance suite pins it and
 * asserts every instant it sees equals it — so an adapter that called `Date.now()` fails a case instead
 * of producing a log nobody can reproduce.
 */
export interface PaymentGatewayDependencies {
  readonly clock: Clock
  readonly records: PaymentRecordSink
}

/**
 * A payment gateway. Six operations, and not one that only makes sense for cash.
 *
 * The shape is M-TILL-07's argument repeated one layer up: *"a cash-shaped interface is the thing that
 * makes the gateway's adapter a set of no-op methods and a comment apologising for them."* So the port
 * is card-shaped, the till adapter implements all six honestly, and where it genuinely cannot do
 * something it says so in {@link GatewayCapabilities} and is held to a refusal for it.
 */
export interface PaymentGateway {
  readonly name: GatewayName
  /** The tender kinds this gateway takes. Every kind is served by exactly one gateway. */
  readonly serves: readonly TenderKind[]
  /** The minor-unit convention this gateway speaks. Converted at this edge and nowhere else. */
  readonly minorUnits: MinorUnitConvention
  readonly capabilities: GatewayCapabilities

  authorise(request: AuthoriseRequest): Promise<GatewayIntentSnapshot>
  capture(request: CaptureRequest): Promise<GatewayIntentSnapshot>
  refund(request: RefundRequest): Promise<GatewayRefundReceipt>
  voidAuthorisation(request: VoidRequest): Promise<GatewayIntentSnapshot>
  /** The gateway's own answer, for reconciliation. Y-PAY-05 diffs local state against this. */
  fetchIntent(gatewayIntentId: GatewayIntentId): Promise<GatewayIntentSnapshot>
  /** Events after `cursor`, oldest first. `null` reads from the beginning. */
  eventsSince(cursor: GatewayEventCursor | null): Promise<readonly GatewayEventDelivery[]>
}

/**
 * The member list, enumerated at runtime, held exactly equal to `keyof PaymentGateway` by a type.
 *
 * M-TILL-07's arrangement for `PaymentAdapter`, and it is here for the same reason: the conformance suite
 * asserts that every member is exercised, and a member added to the interface without a case would
 * otherwise be a method nothing has ever called on any adapter.
 */
export const PAYMENT_GATEWAY_OPERATION_MEMBERS = [
  'authorise',
  'capture',
  'refund',
  'voidAuthorisation',
  'fetchIntent',
  'eventsSince',
] as const

type OperationMember = (typeof PAYMENT_GATEWAY_OPERATION_MEMBERS)[number]

/**
 * `true` only while the list above is exactly the callable members of {@link PaymentGateway}.
 *
 * Both directions: a member added to the interface and not to the list, or listed and not on the
 * interface, fails `tsc`. The property members (`name`, `serves`, `minorUnits`, `capabilities`) are
 * excluded by name rather than by a heuristic, because "is it a function" is not something a mapped type
 * should be guessing about on a hand-written interface.
 */
export type PaymentGatewayMembersAreExact = [OperationMember] extends [keyof PaymentGateway]
  ? [Exclude<keyof PaymentGateway, 'name' | 'serves' | 'minorUnits' | 'capabilities'>] extends [
      OperationMember,
    ]
    ? true
    : false
  : false

export const PAYMENT_GATEWAY_MEMBERS_ARE_EXACT: PaymentGatewayMembersAreExact = true
