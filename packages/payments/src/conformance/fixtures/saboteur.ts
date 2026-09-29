import type {
  AuthoriseRequest,
  CaptureRequest,
  GatewayEventCursor,
  GatewayEventDelivery,
  GatewayIntentId,
  GatewayIntentSnapshot,
  GatewayName,
  GatewayOperation,
  GatewayRefundReceipt,
  IdempotencyKey,
  Instant,
  Money,
  PaymentGateway,
  PaymentGatewayDependencies,
  PaymentIntentEventType,
  PaymentIntentState,
  RefundRequest,
  TenderKind,
  VoidRequest,
} from '@berelax/core'
import {
  ACCOUNTS,
  add,
  assertIntegerFilsAmount,
  assertReferencePresent,
  assertServesInstrument,
  FILS_CONVENTION,
  nextIntentState,
  subtract,
  tenderTypeOf,
  ZERO_AED,
} from '@berelax/core'
import type { FailureScript } from '@berelax/providers/failure'
import { failureError } from '@berelax/providers/failure'
import { AppError } from '@berelax/shared'

/**
 * The deliberately non-conforming gateways. **Fixtures. Never registered, never shipped, never reachable.**
 *
 * ADR 0003: every gate needs a known-bad fixture, because a check that has never been seen to fail may not
 * be a check at all. A conformance suite is the same claim one level up — *a suite nothing has ever failed
 * is a suite that conforms to nothing* — and the acceptance line this file answers is the one about "a
 * deliberately no-op adapter that returns success without writing a visible outbox or ledger record".
 *
 * ## The shape, and why it is one adapter with a switch rather than twenty adapters
 *
 * {@link createSaboteurGateway} is a fourth, independent implementation of the port that conforms when
 * `defect` is `'none'`, with exactly one thing broken otherwise. Two things follow, and both matter:
 *
 *   - **`'none'` is the control.** It has to CONFORM. Without it, every failure below could be explained by
 *     the fixture simply being shoddy, and the rules would be measuring the fixture rather than the defect.
 *     This is the control that the byte-budget and the CMS-field gate fixtures did not have, and their
 *     absence is how three commits came to capture a fixture's value as the real one.
 *   - **Each defect is attributable.** {@link SABOTEUR_EXPECTATIONS} states, per defect, the EXACT set of
 *     rule ids that must fail. `suite.test.ts` asserts set equality, not membership, so a defect that
 *     starts failing an extra rule — or stops failing its own — fails the test rather than staying quietly
 *     red for a reason nobody checked.
 *
 * It is also a third implementation of the money invariants, which is deliberate. If the two shipped
 * adapters shared an invariant kernel the suite would test one implementation twice; this one agrees with
 * them by construction rather than by inheritance.
 */

export const SABOTEUR_GATEWAY = 'saboteur-fixture-gateway' as GatewayName

/**
 * Every way this fixture can be broken. One entry per conformance rule that can be broken from inside an
 * adapter, plus `'none'`.
 */
export const SABOTEUR_DEFECTS = [
  /** The control. Nothing is broken and the suite must accept it. */
  'none',
  /** Returns success and writes no movement at all. The acceptance line's no-op adapter. */
  'records-nothing',
  'records-a-blank-summary',
  'records-the-wrong-amount',
  'records-the-wrong-posting-account',
  'reads-its-own-clock',
  'ignores-the-idempotency-key',
  'serves-any-instrument-it-is-asked-for',
  'accepts-a-blank-reference',
  'accepts-a-fractional-amount',
  'captures-more-than-authorised',
  'refunds-more-than-captured',
  'reports-a-state-the-table-cannot-reach',
  'fetches-an-intent-that-disagrees',
  'declares-a-convention-that-cannot-carry-a-fils',
  'claims-no-events-and-emits-them',
  'claims-no-external-service-and-fails',
  'claims-no-void-and-performs-one',
  'claims-no-partial-capture-and-performs-one',
  'claims-no-partial-refund-and-performs-one',
] as const

export type SaboteurDefect = (typeof SABOTEUR_DEFECTS)[number]

/**
 * The rule ids each defect must make fail, exactly.
 *
 * Several defects fail more than one rule, and that is not slack in the expectation: an adapter that writes
 * no movement breaks every rule that reads one, and stating only the headline rule would let the others
 * silently stop looking. The lists are what the suite ACTUALLY reports, asserted as sets.
 */
export const SABOTEUR_EXPECTATIONS: Readonly<Record<SaboteurDefect, readonly string[]>> =
  Object.freeze({
    none: Object.freeze([]),
    // Three rules, not four. `every-instant-comes-from-the-injected-clock` still PASSES for an adapter that
    // writes nothing, because its remaining subjects — the snapshot and the refund receipt — are honest.
    // That is the right answer rather than a gap: the missing records are `records-every-movement`'s to
    // report, and widening the clock rule to demand a record would give two rules one failure and make the
    // report say less about what is wrong.
    'records-nothing': Object.freeze([
      'idempotency-key-replays-the-first-answer',
      'record-states-the-amount-the-call-was-for',
      'records-every-movement',
    ]),
    'records-a-blank-summary': Object.freeze(['record-carries-a-human-summary']),
    'records-the-wrong-amount': Object.freeze(['record-states-the-amount-the-call-was-for']),
    'records-the-wrong-posting-account': Object.freeze([
      'record-names-the-posting-account-of-its-instrument',
    ]),
    'reads-its-own-clock': Object.freeze(['every-instant-comes-from-the-injected-clock']),
    'ignores-the-idempotency-key': Object.freeze(['idempotency-key-replays-the-first-answer']),
    'serves-any-instrument-it-is-asked-for': Object.freeze([
      'refuses-an-instrument-it-does-not-serve',
    ]),
    'accepts-a-blank-reference': Object.freeze(['refuses-a-blank-reference']),
    'accepts-a-fractional-amount': Object.freeze(['refuses-a-fractional-amount']),
    'captures-more-than-authorised': Object.freeze(['capture-never-exceeds-authorised']),
    'refunds-more-than-captured': Object.freeze([
      'partial-refund-matches-the-declared-capability',
      'refund-never-exceeds-captured',
    ]),
    // Three rules, and the two beyond the primary are the cascade rather than slack in the expectation: an
    // intent that claims to be `captured` before anything was captured cannot then be voided — the table
    // refuses `captured` + `voided`, which is the rule that stops captured money being released — so both
    // rules that reach for a void fail on the way. A fixture whose lie stayed local would be a lie with no
    // consequences, which is not the kind this suite is written against.
    'reports-a-state-the-table-cannot-reach': Object.freeze([
      'record-states-the-amount-the-call-was-for',
      'state-follows-the-declared-transition-table',
      'void-matches-the-declared-capability',
    ]),
    // Two rules, and the second is the cascade that the fold-vs-snapshot assertion added: an adapter whose
    // `fetchIntent` lies also disagrees with its OWN event stream, because the stream is honest. That is the
    // assertion working — a gateway is not allowed to have two different answers about one intent, whichever
    // of the two is wrong.
    'fetches-an-intent-that-disagrees': Object.freeze([
      'event-emission-matches-the-declared-capability',
      'fetch-intent-agrees-with-the-last-answer',
    ]),
    'declares-a-convention-that-cannot-carry-a-fils': Object.freeze([
      'amounts-round-trip-through-the-declared-minor-units',
    ]),
    'claims-no-events-and-emits-them': Object.freeze([
      'event-emission-matches-the-declared-capability',
    ]),
    'claims-no-external-service-and-fails': Object.freeze([
      'external-service-matches-the-declared-capability',
    ]),
    'claims-no-void-and-performs-one': Object.freeze(['void-matches-the-declared-capability']),
    'claims-no-partial-capture-and-performs-one': Object.freeze([
      'partial-capture-matches-the-declared-capability',
    ]),
    'claims-no-partial-refund-and-performs-one': Object.freeze([
      'partial-refund-matches-the-declared-capability',
    ]),
  })

/**
 * The rule each defect is FOR, as against the full set it happens to knock over.
 *
 * Asserted to be among the failures, beside the set-equality assertion on {@link SABOTEUR_EXPECTATIONS}.
 * The two together are what stop the expectation drifting: a set alone could be updated to whatever the
 * suite currently reports, including a list that no longer contains the rule the defect exists to break.
 */
export const SABOTEUR_PRIMARY_RULE: Readonly<Record<SaboteurDefect, string | null>> = Object.freeze(
  {
    none: null,
    'records-nothing': 'records-every-movement',
    'records-a-blank-summary': 'record-carries-a-human-summary',
    'records-the-wrong-amount': 'record-states-the-amount-the-call-was-for',
    'records-the-wrong-posting-account': 'record-names-the-posting-account-of-its-instrument',
    'reads-its-own-clock': 'every-instant-comes-from-the-injected-clock',
    'ignores-the-idempotency-key': 'idempotency-key-replays-the-first-answer',
    'serves-any-instrument-it-is-asked-for': 'refuses-an-instrument-it-does-not-serve',
    'accepts-a-blank-reference': 'refuses-a-blank-reference',
    'accepts-a-fractional-amount': 'refuses-a-fractional-amount',
    'captures-more-than-authorised': 'capture-never-exceeds-authorised',
    'refunds-more-than-captured': 'refund-never-exceeds-captured',
    'reports-a-state-the-table-cannot-reach': 'state-follows-the-declared-transition-table',
    'fetches-an-intent-that-disagrees': 'fetch-intent-agrees-with-the-last-answer',
    'declares-a-convention-that-cannot-carry-a-fils':
      'amounts-round-trip-through-the-declared-minor-units',
    'claims-no-events-and-emits-them': 'event-emission-matches-the-declared-capability',
    'claims-no-external-service-and-fails': 'external-service-matches-the-declared-capability',
    'claims-no-void-and-performs-one': 'void-matches-the-declared-capability',
    'claims-no-partial-capture-and-performs-one': 'partial-capture-matches-the-declared-capability',
    'claims-no-partial-refund-and-performs-one': 'partial-refund-matches-the-declared-capability',
  },
)

export interface SaboteurOptions extends PaymentGatewayDependencies {
  readonly defect: SaboteurDefect
  readonly failures: FailureScript
}

interface FixtureIntent {
  readonly gatewayIntentId: GatewayIntentId
  readonly reference: string
  readonly authorised: Money
  captured: Money
  refunded: Money
  state: PaymentIntentState
}

/** Online cards, like the gateway it stands in for. */
const SERVES: readonly TenderKind[] = Object.freeze(['card_online'])

/** A convention that cannot express one fils. Only reached by the matching defect. */
const WHOLE_DIRHAMS = Object.freeze({ label: 'whole dirhams (a broken fixture)', exponent: 0 })

export function createSaboteurGateway(options: SaboteurOptions): PaymentGateway {
  const { clock, records, failures, defect } = options
  const broken = (name: SaboteurDefect): boolean => defect === name
  const intents = new Map<string, FixtureIntent>()
  const answered = new Map<string, GatewayIntentId>()
  const queue: GatewayEventDelivery[] = []
  let counter = 0
  let eventCounter = 0

  const now = (): Instant =>
    // The one place the fixture can be made to read a clock of its own. `performance.timeOrigin` rather
    // than `Date.now()` so the value is guaranteed to differ from the suite's pinned instant even on a
    // machine whose wall clock somehow matched it.
    broken('reads-its-own-clock') ? (Math.floor(performance.timeOrigin) as Instant) : clock.now()

  const accountFor = (instrument: TenderKind) =>
    broken('records-the-wrong-posting-account')
      ? ACCOUNTS.bankCurrent
      : tenderTypeOf(instrument).account

  const snapshot = (intent: FixtureIntent): GatewayIntentSnapshot =>
    Object.freeze({
      gatewayIntentId: intent.gatewayIntentId,
      state: intent.state,
      instrument: 'card_online' as TenderKind,
      postingAccountCode: tenderTypeOf('card_online').account,
      authorised: intent.authorised,
      captured: intent.captured,
      refunded: intent.refunded,
      observedAt: now(),
    })

  const write = (args: {
    intent: FixtureIntent
    operation: GatewayOperation
    amount: Money
    idempotencyKey: IdempotencyKey
    suppressedDuplicate?: boolean
  }): void => {
    if (broken('records-nothing')) return
    records.record(
      Object.freeze({
        gateway: SABOTEUR_GATEWAY,
        operation: args.operation,
        gatewayIntentId: args.intent.gatewayIntentId,
        instrument: 'card_online' as TenderKind,
        postingAccountCode: accountFor('card_online'),
        amount: broken('records-the-wrong-amount') ? ZERO_AED : args.amount,
        summary: broken('records-a-blank-summary')
          ? ''
          : `${args.operation} of ${String(args.amount.fils)} fils on ${args.intent.gatewayIntentId} ` +
            `for ${args.intent.reference}`,
        occurredAt: now(),
        idempotencyKey: args.idempotencyKey,
        ...(args.suppressedDuplicate === true ? { suppressedDuplicate: true } : {}),
      }),
    )
  }

  const emit = (intent: FixtureIntent, type: PaymentIntentEventType, amount?: Money): void => {
    eventCounter += 1
    queue.push(
      Object.freeze({
        gatewayIntentId: intent.gatewayIntentId,
        cursor: `evt_${String(eventCounter).padStart(8, '0')}` as GatewayEventCursor,
        event: Object.freeze({
          eventId: `evt_${intent.gatewayIntentId}_${type}_${String(eventCounter)}`,
          type,
          occurredAt: now(),
          ...(amount === undefined ? {} : { amount }),
        }),
      }),
    )
  }

  /**
   * Always checks the shared script, whatever the capability flag says.
   *
   * That is the whole of `claims-no-external-service-and-fails`: the defect is not in this function, it is
   * in `hasExternalService` being declared false beside it. An adapter whose flag and whose behaviour
   * disagree is the failure the rule is written against, and it is worth stating here because the tempting
   * version of this fixture — one that stops checking the script — would break nothing at all.
   */
  const armed = (): void => {
    const mode = failures.take()
    if (mode !== undefined) throw failureError(SABOTEUR_GATEWAY, mode)
  }

  const require_ = (gatewayIntentId: GatewayIntentId): FixtureIntent => {
    const intent = intents.get(gatewayIntentId)
    if (intent === undefined) {
      throw new AppError('not_found', `No fixture intent ${gatewayIntentId}`, {
        details: { gatewayIntentId },
      })
    }
    return intent
  }

  return {
    name: SABOTEUR_GATEWAY,
    serves: SERVES,
    minorUnits: broken('declares-a-convention-that-cannot-carry-a-fils')
      ? WHOLE_DIRHAMS
      : FILS_CONVENTION,
    capabilities: Object.freeze({
      emitsEvents: !broken('claims-no-events-and-emits-them'),
      supportsPartialCapture: !broken('claims-no-partial-capture-and-performs-one'),
      supportsPartialRefund: !broken('claims-no-partial-refund-and-performs-one'),
      supportsVoid: !broken('claims-no-void-and-performs-one'),
      hasExternalService: !broken('claims-no-external-service-and-fails'),
    }),

    async authorise(request: AuthoriseRequest): Promise<GatewayIntentSnapshot> {
      if (!broken('serves-any-instrument-it-is-asked-for')) {
        assertServesInstrument(SABOTEUR_GATEWAY, SERVES, request.instrument)
      }
      if (!broken('accepts-a-fractional-amount')) {
        assertIntegerFilsAmount(request.amount, 'the amount authorised')
      }
      if (!broken('accepts-a-blank-reference')) assertReferencePresent(request.reference)
      armed()

      const seen = broken('ignores-the-idempotency-key')
        ? undefined
        : answered.get(request.idempotencyKey)
      if (seen !== undefined) {
        const first = require_(seen)
        write({
          intent: first,
          operation: 'authorise',
          amount: first.authorised,
          idempotencyKey: request.idempotencyKey,
          suppressedDuplicate: true,
        })
        return snapshot(first)
      }

      counter += 1
      const gatewayIntentId = `sab_${String(counter).padStart(6, '0')}` as GatewayIntentId
      const intent: FixtureIntent = {
        gatewayIntentId,
        reference: request.reference,
        authorised: request.amount,
        captured: ZERO_AED,
        refunded: ZERO_AED,
        state: broken('reports-a-state-the-table-cannot-reach')
          ? 'captured'
          : nextIntentState('requires_authorisation', 'authorised'),
      }
      intents.set(gatewayIntentId, intent)
      answered.set(request.idempotencyKey, gatewayIntentId)
      emit(intent, 'authorised', request.amount)
      write({
        intent,
        operation: 'authorise',
        amount: request.amount,
        idempotencyKey: request.idempotencyKey,
      })
      return snapshot(intent)
    },

    async capture(request: CaptureRequest): Promise<GatewayIntentSnapshot> {
      assertIntegerFilsAmount(request.amount, 'the amount captured')
      armed()
      const intent = require_(request.gatewayIntentId)

      const seen = answered.get(request.idempotencyKey)
      if (seen !== undefined) {
        write({
          intent,
          operation: 'capture',
          amount: request.amount,
          idempotencyKey: request.idempotencyKey,
          suppressedDuplicate: true,
        })
        return snapshot(require_(seen))
      }

      const after = add(intent.captured, request.amount)
      if (!broken('captures-more-than-authorised') && after.fils > intent.authorised.fils) {
        throw new AppError(
          'validation',
          `A capture of ${request.amount.fils} fils would exceed the ${intent.authorised.fils} fils ` +
            'authorised.',
          { details: { gatewayIntentId: intent.gatewayIntentId } },
        )
      }
      if (intent.state !== 'captured') intent.state = nextIntentState(intent.state, 'captured')
      intent.captured = after
      answered.set(request.idempotencyKey, intent.gatewayIntentId)
      emit(intent, 'captured', request.amount)
      write({
        intent,
        operation: 'capture',
        amount: request.amount,
        idempotencyKey: request.idempotencyKey,
      })
      return snapshot(intent)
    },

    async refund(request: RefundRequest): Promise<GatewayRefundReceipt> {
      assertIntegerFilsAmount(request.amount, 'the amount refunded')
      armed()
      const intent = require_(request.gatewayIntentId)

      const seen = answered.get(request.idempotencyKey)
      if (seen !== undefined) {
        write({
          intent,
          operation: 'refund',
          amount: request.amount,
          idempotencyKey: request.idempotencyKey,
          suppressedDuplicate: true,
        })
        return Object.freeze({
          refundId: `sab_re_${request.idempotencyKey}`,
          gatewayIntentId: intent.gatewayIntentId,
          amount: request.amount,
          acknowledgedAt: now(),
        })
      }

      const after = add(intent.refunded, request.amount)
      if (!broken('refunds-more-than-captured') && after.fils > intent.captured.fils) {
        throw new AppError(
          'validation',
          `A refund of ${request.amount.fils} fils exceeds the ` +
            `${subtract(intent.captured, intent.refunded).fils} fils still refundable.`,
          { details: { gatewayIntentId: intent.gatewayIntentId } },
        )
      }
      intent.state = nextIntentState(intent.state, 'refunded')
      intent.refunded = after
      counter += 1
      answered.set(request.idempotencyKey, intent.gatewayIntentId)
      emit(intent, 'refunded', request.amount)
      write({
        intent,
        operation: 'refund',
        amount: request.amount,
        idempotencyKey: request.idempotencyKey,
      })
      return Object.freeze({
        refundId: `sab_re_${String(counter).padStart(6, '0')}`,
        gatewayIntentId: intent.gatewayIntentId,
        amount: request.amount,
        acknowledgedAt: now(),
      })
    },

    async voidAuthorisation(request: VoidRequest): Promise<GatewayIntentSnapshot> {
      armed()
      const intent = require_(request.gatewayIntentId)
      intent.state = nextIntentState(intent.state, 'voided')
      emit(intent, 'voided')
      write({
        intent,
        operation: 'void',
        amount: ZERO_AED,
        idempotencyKey: request.idempotencyKey,
      })
      return snapshot(intent)
    },

    async fetchIntent(gatewayIntentId: GatewayIntentId): Promise<GatewayIntentSnapshot> {
      armed()
      const intent = require_(gatewayIntentId)
      if (!broken('fetches-an-intent-that-disagrees')) return snapshot(intent)
      return Object.freeze({ ...snapshot(intent), authorised: ZERO_AED })
    },

    async eventsSince(cursor: GatewayEventCursor | null): Promise<readonly GatewayEventDelivery[]> {
      armed()
      return cursor === null ? [...queue] : queue.filter((delivery) => delivery.cursor > cursor)
    },
  }
}
