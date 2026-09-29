import { AppError } from '@berelax/shared'
import type { Money } from '../money.ts'
import { add, filsFrom, subtract, ZERO_AED } from '../money.ts'
import type { Instant } from '../time.ts'

/**
 * The payment intent's lifecycle, as a declared table and a fold over gateway events.
 *
 * Pure: no clock, no I/O, no adapter. Every instant this module reasons about arrives on an event that
 * a caller read from a gateway, which is what makes the answer reproducible from a stored event list —
 * the property Y-PAY-05's reconciliation and Y-PAY-08's chargeback unwind both depend on.
 *
 * ## Two layers, and why they are separate
 *
 * **Reachability** is the (state, event) table: may this event happen to an intent in this state at
 * all. **Magnitude** is the amount fold: captured never exceeds authorised, refunded never exceeds
 * captured. Keeping them apart is not tidiness. A table whose target state depended on amounts could
 * not be asserted total over the enum product — the thing Y-PAY-02's exhaustive test does — because
 * "fully refunded" is a fact about two numbers and not about a cell. So refund fullness is
 * {@link isFullyRefunded}, derived, and `captured` stays one state however much of it has come back.
 *
 * ## Ordering is resolved before the fold, not inside it
 *
 * Webhooks are at-least-once and arrive out of order: a capture notification routinely overtakes the
 * authorisation it belongs to. {@link reduceIntent} therefore sorts by the gateway's `occurredAt`
 * before folding, so the answer is a function of the SET of events and not of the order they reached
 * us. That is what lets the table stay strict — a capture on an unauthorised intent is a real defect
 * and is refused — while a shuffled delivery still converges. The alternative, a permissive table that
 * accepts capture-before-authorisation, cannot tell the two apart and would silently accept a capture
 * for an intent the gateway never authorised.
 *
 * `eventId` breaks ties, because two events can share an instant and a fold that depended on the input
 * order for those would be order-dependent in exactly the case that is hardest to reproduce.
 *
 * ## The fold is idempotent on `eventId`, and it has to be
 *
 * "A function of the SET of events" is only true if a set has no duplicates. A gateway stream is
 * at-least-once — the H02 fake redelivers every event deliberately, because a consumer that has only ever
 * seen one copy has an idempotency bug it has not met yet — so a fold that counted both copies of a
 * `captured` event would report twice the money. {@link reduceIntent} therefore keeps the FIRST delivery of
 * each `eventId` and drops the rest.
 *
 * This was a real defect in this module, found by writing the test that folds the fake's own stream and
 * comparing it with what the fake reports: a capture of AED 200 on an AED 350 authorisation folded to AED
 * 400 and threw {@link CaptureExceedsAuthorised}. The refusal fired, which is the system working — but the
 * cause was here, not in the gateway, and an at-least-once stream is the normal case rather than the edge.
 *
 * Two events that genuinely share an id are a gateway defect this cannot detect, so the first wins and the
 * second is dropped. That is the same choice ADR 0008's exactly-once-per-handler makes, one layer up: the
 * id is the identity, and a system that treated a redelivery as new would be the failure being guarded
 * against. An authorisation INCREASE is therefore a new event with a new id, not a resend — which is why
 * `authorised` takes the largest amount seen rather than the first.
 */

/** The intent's lifecycle states. Amounts are separate; see the module note. */
export const PAYMENT_INTENT_STATES = [
  /** Created. Nothing is reserved and the gateway has not answered yet. */
  'requires_authorisation',
  /** 3DS or another challenge is outstanding. The customer may never come back. */
  'requires_customer_action',
  /** Funds reserved, nothing taken. */
  'authorised',
  /** At least one capture has succeeded. Partial or full; the amounts say which. */
  'captured',
  /** The authorisation was released without taking anything. Terminal. */
  'voided',
  /** The gateway refused the authorisation. Terminal. */
  'failed',
] as const

export type PaymentIntentState = (typeof PAYMENT_INTENT_STATES)[number]

/** Where every intent starts. Not a transition: nothing precedes it. */
export const PAYMENT_INTENT_INITIAL_STATE: PaymentIntentState = 'requires_authorisation'

/**
 * What a gateway can tell us happened.
 *
 * Only the gateway moves an intent. A client callback is not on this list and cannot be: a browser
 * that says "it worked" has not been anywhere near the money, which is the defect Y-PAY-04's acceptance
 * line about the client callback path is written against.
 */
export const PAYMENT_INTENT_EVENTS = [
  'action_required',
  'authorised',
  'authorisation_failed',
  'captured',
  'refunded',
  'voided',
] as const

export type PaymentIntentEventType = (typeof PAYMENT_INTENT_EVENTS)[number]

/**
 * The cell for a (state, event) pair the lifecycle does not allow.
 *
 * A value rather than an absent key, so {@link INTENT_TRANSITIONS} is a total `Record` over both enums
 * and `tsc` refuses a state or an event added without a decision for every pair it makes. A
 * `Partial<Record<…>>` would compile with the new row missing and resolve every one of its pairs to
 * "not allowed" silently — which is the answer for most of them and the wrong way to arrive at it.
 */
export const TRANSITION_REFUSED = 'refused' as const
export type TransitionRefused = typeof TRANSITION_REFUSED

/**
 * Every (state, event) pair, and what it does.
 *
 * Read across a row to see what may happen to an intent in that state. The cells worth reading twice:
 *
 * - **`authorised` while already `captured` → `captured`.** A redelivered authorisation webhook must
 *   not move a captured intent backwards. This is the single cell that makes at-least-once delivery
 *   safe, and getting it wrong un-captures money that has been taken.
 * - **`authorisation_failed` from `authorised` → refused.** A gateway does not un-authorise; releasing
 *   a reservation is a void, and it has its own event because it has its own ledger consequence.
 * - **`voided` from `captured` → refused.** Money that has been taken is refunded, not voided. Voiding
 *   it would release a reservation that no longer exists and leave the capture unaccounted for.
 * - **The replays on the diagonal of the terminal states.** `voided`+`voided` and
 *   `failed`+`authorisation_failed` stay put rather than refusing, because a terminal intent is exactly
 *   the one a gateway retries hardest, and a refusal there would turn a duplicate delivery into an
 *   incident.
 */
export const INTENT_TRANSITIONS: Readonly<
  Record<
    PaymentIntentState,
    Readonly<Record<PaymentIntentEventType, PaymentIntentState | TransitionRefused>>
  >
> = Object.freeze({
  requires_authorisation: Object.freeze({
    action_required: 'requires_customer_action',
    authorised: 'authorised',
    authorisation_failed: 'failed',
    captured: TRANSITION_REFUSED,
    refunded: TRANSITION_REFUSED,
    voided: 'voided',
  }),
  requires_customer_action: Object.freeze({
    // A second "a challenge is outstanding" is a redelivery, not a second challenge.
    action_required: 'requires_customer_action',
    authorised: 'authorised',
    authorisation_failed: 'failed',
    captured: TRANSITION_REFUSED,
    refunded: TRANSITION_REFUSED,
    voided: 'voided',
  }),
  authorised: Object.freeze({
    action_required: TRANSITION_REFUSED,
    authorised: 'authorised',
    authorisation_failed: TRANSITION_REFUSED,
    captured: 'captured',
    refunded: TRANSITION_REFUSED,
    voided: 'voided',
  }),
  captured: Object.freeze({
    action_required: TRANSITION_REFUSED,
    authorised: 'captured',
    authorisation_failed: TRANSITION_REFUSED,
    captured: 'captured',
    refunded: 'captured',
    voided: TRANSITION_REFUSED,
  }),
  voided: Object.freeze({
    action_required: TRANSITION_REFUSED,
    authorised: TRANSITION_REFUSED,
    authorisation_failed: TRANSITION_REFUSED,
    captured: TRANSITION_REFUSED,
    refunded: TRANSITION_REFUSED,
    voided: 'voided',
  }),
  failed: Object.freeze({
    action_required: TRANSITION_REFUSED,
    authorised: TRANSITION_REFUSED,
    authorisation_failed: 'failed',
    captured: TRANSITION_REFUSED,
    refunded: TRANSITION_REFUSED,
    voided: TRANSITION_REFUSED,
  }),
})

/**
 * The states no event can leave. Derived from the table, so it cannot disagree with it.
 *
 * **`captured` is one of them, and that is not an oversight.** An intent that has taken money can never be
 * voided, can never fail, and stays `captured` however much of it comes back — because refund fullness is an
 * amount fact ({@link isFullyRefunded}) rather than a state, for the reason in the module note. So the state
 * is absorbing while the intent is still very much alive: further captures and refunds are allowed and
 * change the amounts.
 *
 * Which is why this is "no event can leave" and not "nothing more can happen". The first version of the test
 * for this expected `['failed', 'voided']` and was wrong about the table rather than the other way round.
 */
export const ABSORBING_INTENT_STATES: readonly PaymentIntentState[] = Object.freeze(
  PAYMENT_INTENT_STATES.filter((state) =>
    PAYMENT_INTENT_EVENTS.every((event) => {
      const target = INTENT_TRANSITIONS[state][event]
      return target === TRANSITION_REFUSED || target === state
    }),
  ),
)

/**
 * Which events carry an amount, and which must not.
 *
 * Stated as data because both directions are refusals. A `captured` event with no amount is a capture
 * of an unknown quantity, which the fold would have to guess at; a `voided` event WITH one reads as a
 * partial void, which does not exist — an authorisation is released whole.
 */
export const INTENT_EVENT_CARRIES_AMOUNT: Readonly<Record<PaymentIntentEventType, boolean>> =
  Object.freeze({
    action_required: false,
    authorised: true,
    authorisation_failed: false,
    captured: true,
    refunded: true,
    voided: false,
  })

/** One thing the gateway says happened, as the caller read it. */
export interface PaymentIntentEvent {
  /** Stable across redeliveries. The tiebreaker when two events share an instant. */
  readonly eventId: string
  readonly type: PaymentIntentEventType
  /** The gateway's own instant, not ours. What the fold orders by. */
  readonly occurredAt: Instant
  /** Present exactly when {@link INTENT_EVENT_CARRIES_AMOUNT} says so. */
  readonly amount?: Money
}

/** Every figure an intent has, in integer fils. Derived from the events and nothing else. */
export interface PaymentIntentAmounts {
  readonly authorised: Money
  readonly captured: Money
  readonly refunded: Money
  /** `authorised - captured`. Zero once voided, because the reservation is gone. */
  readonly capturable: Money
  /** `captured - refunded`. */
  readonly refundable: Money
}

/** The whole answer for one intent. */
export interface PaymentIntentProjection {
  readonly state: PaymentIntentState
  readonly amounts: PaymentIntentAmounts
  /** The events in the order the fold applied them, which is the gateway's order. */
  readonly applied: readonly PaymentIntentEvent[]
}

/** Raised when the table's cell for a (state, event) pair is {@link TRANSITION_REFUSED}. */
export class IntentTransitionRefused extends AppError {
  constructor(from: PaymentIntentState, event: PaymentIntentEventType, eventId: string) {
    super(
      'conflict',
      `IntentTransitionRefused: a "${event}" event cannot reach an intent that is "${from}". The ` +
        'lifecycle table in @berelax/core declares every pair, and this one is not allowed — which ' +
        'means either the gateway sent an event for the wrong intent or an earlier event is missing.',
      { details: { from, event, eventId } },
    )
    this.name = 'IntentTransitionRefused'
  }
}

/** Raised when an event's amount disagrees with {@link INTENT_EVENT_CARRIES_AMOUNT}. */
export class IntentEventAmountMalformed extends AppError {
  constructor(event: PaymentIntentEventType, eventId: string, problem: 'missing' | 'unexpected') {
    super(
      'validation',
      problem === 'missing'
        ? `IntentEventAmountMalformed: a "${event}" event carries no amount. A movement of an unknown ` +
            'quantity cannot be folded into a balance, and defaulting it to zero would make the ' +
            'intent read as settled for nothing.'
        : `IntentEventAmountMalformed: a "${event}" event carries an amount, and that event moves no ` +
            'money. An authorisation is released whole; a partial void does not exist.',
      { details: { event, eventId, problem } },
    )
    this.name = 'IntentEventAmountMalformed'
  }
}

/** Raised when the captures against an intent exceed what was authorised. */
export class CaptureExceedsAuthorised extends AppError {
  constructor(capturedFils: number, authorisedFils: number, eventId: string) {
    super(
      'invariant_violated',
      `CaptureExceedsAuthorised: ${capturedFils} fils captured against ${authorisedFils} fils ` +
        'authorised. A gateway cannot take more than it reserved, so this is a mis-routed event or a ' +
        'lost authorisation increase — never a capture to accept.',
      { details: { capturedFils, authorisedFils, eventId } },
    )
    this.name = 'CaptureExceedsAuthorised'
  }
}

/** Raised when the refunds against an intent exceed what was captured. */
export class RefundExceedsCaptured extends AppError {
  constructor(refundedFils: number, capturedFils: number, eventId: string) {
    super(
      'invariant_violated',
      `RefundExceedsCaptured: ${refundedFils} fils refunded against ${capturedFils} fils captured. ` +
        'Money that was never taken cannot be given back; the excess would be a payment out with no ' +
        'receipt behind it.',
      { details: { refundedFils, capturedFils, eventId } },
    )
    this.name = 'RefundExceedsCaptured'
  }
}

const NO_AMOUNTS: PaymentIntentAmounts = Object.freeze({
  authorised: ZERO_AED,
  captured: ZERO_AED,
  refunded: ZERO_AED,
  capturable: ZERO_AED,
  refundable: ZERO_AED,
})

/** The empty projection, before any event. What a freshly created intent reads as. */
export const EMPTY_INTENT: PaymentIntentProjection = Object.freeze({
  state: PAYMENT_INTENT_INITIAL_STATE,
  amounts: NO_AMOUNTS,
  applied: Object.freeze([]),
})

/**
 * The next state for one (state, event) pair, or {@link IntentTransitionRefused}.
 *
 * Separate from {@link reduceIntent} because Y-PAY-02 asserts the table total over the enum product and
 * needs the refusal as a throw for every pair outside it; and because a caller holding a stored state
 * wants to know whether one event is allowed without rebuilding the whole projection.
 */
export function nextIntentState(
  from: PaymentIntentState,
  event: PaymentIntentEventType,
  eventId = '(none)',
): PaymentIntentState {
  const target = INTENT_TRANSITIONS[from][event]
  if (target === TRANSITION_REFUSED) throw new IntentTransitionRefused(from, event, eventId)
  return target
}

/** Does the table allow this pair? The predicate form, for a caller that must not throw. */
export function isIntentTransitionAllowed(
  from: PaymentIntentState,
  event: PaymentIntentEventType,
): boolean {
  return INTENT_TRANSITIONS[from][event] !== TRANSITION_REFUSED
}

function amountOf(event: PaymentIntentEvent): Money {
  const carries = INTENT_EVENT_CARRIES_AMOUNT[event.type]
  if (carries && event.amount === undefined) {
    throw new IntentEventAmountMalformed(event.type, event.eventId, 'missing')
  }
  if (!carries && event.amount !== undefined) {
    throw new IntentEventAmountMalformed(event.type, event.eventId, 'unexpected')
  }
  return event.amount ?? ZERO_AED
}

/**
 * Folds a set of gateway events into one intent.
 *
 * Sorted by the gateway's instant first, so the answer is a function of the set and not of the delivery
 * order — see the module note. The sort is stable on `eventId` and the input array is not mutated,
 * because a caller passing its own stored array should not find it reordered.
 *
 * The fold is deliberately NOT tolerant. A refused transition or a broken amount invariant throws,
 * naming the event, rather than being skipped: an intent that quietly ignored the one event it could
 * not explain would report a balance that reconciles against nothing, and Y-PAY-05's job is to find
 * divergence rather than to have it hidden here.
 */
export function reduceIntent(events: readonly PaymentIntentEvent[]): PaymentIntentProjection {
  const sorted = [...events].sort(
    (a, b) =>
      a.occurredAt - b.occurredAt || (a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0),
  )

  // Deduplicated AFTER sorting, so which copy survives is a function of the set rather than of the
  // delivery order — a dedupe over the raw input would keep whichever copy arrived first and make
  // `applied` order-dependent again for two events sharing an id.
  const seen = new Set<string>()
  const ordered = sorted.filter((event) => {
    if (seen.has(event.eventId)) return false
    seen.add(event.eventId)
    return true
  })

  let state: PaymentIntentState = PAYMENT_INTENT_INITIAL_STATE
  let authorised = ZERO_AED
  let captured = ZERO_AED
  let refunded = ZERO_AED

  for (const event of ordered) {
    const amount = amountOf(event)
    state = nextIntentState(state, event.type, event.eventId)

    switch (event.type) {
      case 'authorised':
        // The LARGEST authorisation seen, not a sum. A redelivered authorisation is the same
        // reservation reported twice; adding it would double the ceiling every capture is checked
        // against, which is the one arithmetic mistake here that makes an over-capture look legal.
        authorised = amount.fils > authorised.fils ? amount : authorised
        break
      case 'captured':
        captured = add(captured, amount)
        if (captured.fils > authorised.fils) {
          throw new CaptureExceedsAuthorised(captured.fils, authorised.fils, event.eventId)
        }
        break
      case 'refunded':
        refunded = add(refunded, amount)
        if (refunded.fils > captured.fils) {
          throw new RefundExceedsCaptured(refunded.fils, captured.fils, event.eventId)
        }
        break
      case 'voided':
        // The reservation is gone. `authorised` is left as it was, because it is the record of what
        // WAS reserved; `capturable` is what becomes zero, and it is derived below.
        break
      case 'action_required':
      case 'authorisation_failed':
        break
    }
  }

  const voided = state === 'voided'
  return Object.freeze({
    state,
    amounts: Object.freeze({
      authorised,
      captured,
      refunded,
      capturable: voided ? ZERO_AED : subtract(authorised, captured),
      refundable: subtract(captured, refunded),
    }),
    applied: Object.freeze(ordered),
  })
}

/**
 * How many deliveries in a stream were redeliveries of an event already in it.
 *
 * Exported because a reconciliation job wants to report it and because a test that asserts the fold is
 * idempotent has to be able to show that the input it used actually contained duplicates — an idempotence
 * test over a stream with none of them passes for a fold that does not deduplicate at all.
 */
export function countRedeliveries(events: readonly PaymentIntentEvent[]): number {
  const seen = new Set<string>()
  let redeliveries = 0
  for (const event of events) {
    if (seen.has(event.eventId)) redeliveries += 1
    else seen.add(event.eventId)
  }
  return redeliveries
}

/**
 * Has every fils that was taken been given back?
 *
 * A predicate and not a state, for the reason in the module note. `captured > 0` is part of it: an
 * intent that never captured anything has refunded everything it took, and calling that "fully
 * refunded" would put a voided authorisation on a refunds report.
 */
export function isFullyRefunded(amounts: PaymentIntentAmounts): boolean {
  return amounts.captured.fils > 0 && amounts.refunded.fils === amounts.captured.fils
}

/**
 * The amount a capture may still take, refusing one that is over.
 *
 * The check a caller needs BEFORE asking a gateway to capture, as against the fold's check after the
 * gateway says it did. Both exist because they answer different questions: this one stops the request,
 * and the fold's one stops a gateway's answer being believed.
 */
export function assertCapturable(amounts: PaymentIntentAmounts, request: Money): void {
  if (request.fils > amounts.capturable.fils) {
    throw new CaptureExceedsAuthorised(
      filsFrom(amounts.captured.fils + request.fils),
      amounts.authorised.fils,
      '(not yet sent)',
    )
  }
}

/** The mirror of {@link assertCapturable} for refunds. */
export function assertRefundable(amounts: PaymentIntentAmounts, request: Money): void {
  if (request.fils > amounts.refundable.fils) {
    throw new RefundExceedsCaptured(
      filsFrom(amounts.refunded.fils + request.fils),
      amounts.captured.fils,
      '(not yet sent)',
    )
  }
}
