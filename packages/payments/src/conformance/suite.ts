import type {
  Clock,
  Fils,
  GatewayIntentSnapshot,
  IdempotencyKey,
  Instant,
  Money,
  PaymentGateway,
  PaymentIntentState,
  PaymentRecordSink,
  TenderKind,
} from '@berelax/core'
import {
  filsFrom,
  fixedClock,
  INTENT_TRANSITIONS,
  isIntentTransitionAllowed,
  money,
  nextIntentState,
  PAYMENT_INTENT_EVENTS,
  PAYMENT_INTENT_INITIAL_STATE,
  reduceIntent,
  survivesMinorUnitRoundTrip,
  TENDER_KINDS,
  TENDER_TYPES,
  TRANSITION_REFUSED,
} from '@berelax/core'
import { FailureScript, failureModeOf } from '@berelax/providers/failure'
import { type AppError, isAppError } from '@berelax/shared'
import { createRecordSink } from '../record-sink.ts'

/**
 * The adapter conformance suite (ADR 0055).
 *
 * This is what makes the word "adapter" mean something. An object that satisfies `PaymentGateway`
 * satisfies a set of type signatures; `tsc` cannot tell an adapter that records a movement from one that
 * returns `{ ok: true }` and writes nothing, and the second one demos perfectly. So the contract is
 * behavioural, it is stated once here, and it runs against every adapter in the registry — including the
 * real one, on the day there is one, without a line being added to this file.
 *
 * ## Why it is a runner rather than a `describe` block
 *
 * A suite of `it(...)` cases can assert that an adapter conforms. It cannot assert that an adapter FAILS a
 * named rule, and that second direction is the whole of ADR 0003: a conformance suite nothing has ever
 * failed is a suite that conforms to nothing. So {@link runPaymentGatewayConformance} returns a report of
 * per-rule results, and `suite.test.ts` uses it twice — once to require every adapter to pass every rule,
 * and once to require the deliberately broken fixtures to fail EXACTLY the rules they break, by id. A
 * fixture that started failing for some other reason fails that test rather than quietly still being red.
 *
 * It also means the runner is callable outside vitest — from a gate case, from a boot-time check on a real
 * adapter — which a `describe` block is not.
 *
 * ## Why no rule is ever skipped
 *
 * Every capability an adapter declares is checked in BOTH directions, so a `false` is a refusal the suite
 * demands rather than a case it steps over. `supportsVoid: false` means a void must be REFUSED; `true`
 * means it must work and must then block a capture. `emitsEvents: false` means the stream must be empty
 * after a capture that would otherwise have filled it. `hasExternalService: false` means an armed failure
 * must change nothing. The report therefore carries one result per declared rule for every candidate, and
 * `suite.test.ts` asserts that count — because the failure mode a capability flag invites is an adapter
 * that opts out of the contract by declaring itself unable, and the first one to do it would be the real
 * one, in production, on the path nobody had exercised.
 */

/** One rule, as the report and the failure message name it. */
export interface ConformanceRule {
  /** Stable. Named in assertions, in gate cases and in a failure message. Never renamed casually. */
  readonly id: string
  readonly title: string
  /** What goes wrong in production when an adapter breaks it. */
  readonly why: string
}

export interface ConformanceRuleResult {
  readonly ruleId: string
  readonly passed: boolean
  /** Empty when it passed; the violation in one sentence when it did not. */
  readonly detail: string
}

export interface ConformanceReport {
  readonly candidate: string
  readonly results: readonly ConformanceRuleResult[]
  /** The ids that failed, sorted, so an assertion can name them. */
  readonly failed: readonly string[]
  readonly conforms: boolean
}

/** What the suite is given: a name, and a way to build the adapter with the suite's own dependencies. */
export interface ConformanceCandidate {
  readonly name: string
  build(deps: {
    readonly clock: Clock
    readonly records: PaymentRecordSink
    readonly failures: FailureScript
  }): PaymentGateway
}

/** Raised inside a rule when the adapter under test breaks it. Never escapes the runner. */
class ConformanceViolation extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConformanceViolation'
  }
}

/** The instant every clock in this suite is pinned to. Any fixed value; this one is the build's date. */
const PINNED_ISO = '2026-09-28T19:30:00.000Z'

/**
 * Probe amounts, in fils.
 *
 * `26_250` is ADR 0007's own example — AED 262.50, the figure a net-first system rounds and a gross-first
 * one does not — and it is here because it is the amount most likely to expose a minor-unit convention that
 * cannot carry it. `1` is the smallest movement the business can make, and an adapter that loses it loses
 * every rounding remainder in the ledger.
 */
const PROBE_FILS: readonly number[] = Object.freeze([1, 35_000, 26_250, 999_999])

interface RuleContext {
  readonly gateway: PaymentGateway
  readonly records: PaymentRecordSink
  readonly failures: FailureScript
  readonly at: Instant
  /** The first kind the gateway serves. What every positive path is exercised with. */
  readonly instrument: TenderKind
  key(label: string): IdempotencyKey
}

interface Rule extends ConformanceRule {
  check(ctx: RuleContext): Promise<void>
}

const violate = (message: string): never => {
  throw new ConformanceViolation(message)
}

/** Asserts a call is refused with an `AppError`, and returns it. A bare `throw` is also a failure. */
async function refuses(what: string, call: () => Promise<unknown>): Promise<AppError> {
  let result: unknown
  try {
    result = await call()
  } catch (error) {
    if (!isAppError(error)) {
      return violate(
        `${what} was refused with ${String(error)}, which is not an AppError. A refusal a caller cannot ` +
          'branch on is a 500 with extra steps.',
      )
    }
    return error
  }
  return violate(
    `${what} SUCCEEDED and returned ${JSON.stringify(result)}. The port says it must refuse; an adapter ` +
      'that silently succeeds here is the defect this suite exists to find.',
  )
}

const inFils = (value: number): Money => money(filsFrom(value))

/** A fractional amount, reachable only through the cast a request body has already been through. */
const fractionalAmount = (): Money => ({ fils: 12.5 as Fils, currency: 'AED' })

const notServed = (gateway: PaymentGateway): TenderKind => {
  const other = TENDER_KINDS.find((kind) => !gateway.serves.includes(kind))
  if (other === undefined) {
    return violate(
      `${gateway.name} declares every tender kind, so there is none left to prove it refuses one. A ` +
        'gateway that serves everything cannot be the wrong gateway for anything.',
    )
  }
  return other
}

/** Movements the adapter actually made, i.e. excluding the ones it marked as suppressed replays. */
const realMovements = (records: PaymentRecordSink) =>
  records.all().filter((movement) => movement.suppressedDuplicate !== true)

/** The states an intent can be in immediately after an authorisation, from the table and not a list. */
const statesAfterAuthorisation = (): readonly PaymentIntentState[] =>
  PAYMENT_INTENT_EVENTS.flatMap((event) => {
    const target = INTENT_TRANSITIONS[PAYMENT_INTENT_INITIAL_STATE][event]
    return target === TRANSITION_REFUSED ? [] : [target]
  })

/** Authorise, for the many rules whose first step it is. */
async function authorised(
  ctx: RuleContext,
  amountFils: number,
  label: string,
): Promise<GatewayIntentSnapshot> {
  return ctx.gateway.authorise({
    amount: inFils(amountFils),
    instrument: ctx.instrument,
    idempotencyKey: ctx.key(label),
    reference: `CONF-${label}`,
  })
}

const RULES: readonly Rule[] = Object.freeze([
  {
    id: 'records-every-movement',
    title: 'every successful call writes a movement to the visible sink before returning',
    why:
      'ADR 0022 rule 1: a stub that returns success and writes nothing makes a broken system demo ' +
      'perfectly, and the day it is swapped for the real thing is the day every error path is met for ' +
      'the first time, in production. The sink is also what a cash payment is reconciled against, so a ' +
      'movement nobody can see is a movement nobody can tie to a ledger entry.',
    async check(ctx) {
      const opened = await authorised(ctx, 35_000, 'records')
      if (realMovements(ctx.records).length !== 1) {
        violate(
          `authorise wrote ${realMovements(ctx.records).length} movements; exactly one was expected. ` +
            'A success with no record is the defect; two records for one call is a double posting.',
        )
      }
      const captureAmount = ctx.gateway.capabilities.supportsPartialCapture ? 15_000 : 35_000
      await ctx.gateway.capture({
        gatewayIntentId: opened.gatewayIntentId,
        amount: inFils(captureAmount),
        idempotencyKey: ctx.key('records-capture'),
      })
      await ctx.gateway.refund({
        gatewayIntentId: opened.gatewayIntentId,
        amount: inFils(captureAmount),
        idempotencyKey: ctx.key('records-refund'),
        reason: 'conformance probe',
      })
      const operations = realMovements(ctx.records).map((movement) => movement.operation)
      for (const expected of ['authorise', 'capture', 'refund'] as const) {
        if (!operations.includes(expected)) {
          violate(
            `no movement was recorded for ${expected}; the sink holds ${operations.join(', ')}`,
          )
        }
      }
    },
  },
  {
    id: 'record-carries-a-human-summary',
    title: 'every movement carries a sentence an operator can read',
    why:
      'The sink is the payments screen. ADR 0022 asserts the summary is not empty for every provider ' +
      'because a blank row on an inbox is the same lie in a different font — it says a thing happened ' +
      'and tells nobody what.',
    async check(ctx) {
      await authorised(ctx, 35_000, 'summary')
      for (const movement of ctx.records.all()) {
        const summary = movement.summary.trim()
        if (summary.length < 12 || !summary.includes(' ')) {
          violate(
            `the ${movement.operation} movement's summary is ${JSON.stringify(movement.summary)}, ` +
              'which is not a sentence. An operator reading the payments screen learns nothing from it.',
          )
        }
      }
    },
  },
  {
    id: 'record-states-the-amount-the-call-was-for',
    title: "the movement's amount is the amount of the call, in integer fils and with a currency",
    why:
      'This figure is what Y-PAY-02 writes a `payment` row from and what Y-PAY-09 reconciles a payout ' +
      'against. An adapter that records a plausible-looking zero, or the amount it rounded to, produces ' +
      'a settlement that will not balance and no single line to point at.',
    async check(ctx) {
      const opened = await authorised(ctx, 26_250, 'amount')
      const first = realMovements(ctx.records)[0]
      if (first === undefined) violate('no movement to check the amount of')
      if (first?.amount.fils !== 26_250 || first.amount.currency !== 'AED') {
        violate(
          `authorise of 26250 fils recorded ${JSON.stringify(first?.amount)}. The record must state the ` +
            'amount the call was for, in the currency it was for.',
        )
      }
      if (!ctx.gateway.capabilities.supportsVoid) return
      await ctx.gateway.voidAuthorisation({
        gatewayIntentId: opened.gatewayIntentId,
        idempotencyKey: ctx.key('amount-void'),
      })
      const voided = realMovements(ctx.records).find((movement) => movement.operation === 'void')
      if (voided?.amount.fils !== 0) {
        violate(
          `the void movement records ${String(voided?.amount.fils)} fils. A void releases a reservation ` +
            'and moves nothing, so anything but zero reads as money that changed hands.',
        )
      }
    },
  },
  {
    id: 'record-names-the-posting-account-of-its-instrument',
    title: "every movement names the instrument's registered posting account",
    why:
      'The account is snapshotted onto the movement rather than joined to later, for ' +
      "`payment.posting_account_code`'s reason: re-mapping an instrument in two years must not restate " +
      'a posting already filed. An adapter that names a different account posts real money to the wrong ' +
      'clearing account, and the error surfaces as a bank reconciliation that is out by every batch.',
    async check(ctx) {
      await authorised(ctx, 35_000, 'account')
      for (const movement of ctx.records.all()) {
        if (!ctx.gateway.serves.includes(movement.instrument)) {
          violate(
            `a movement names instrument "${movement.instrument}", which this gateway does not serve ` +
              `(${ctx.gateway.serves.join(', ')})`,
          )
        }
        const expected = TENDER_TYPES[movement.instrument].account
        if (movement.postingAccountCode !== expected) {
          violate(
            `a "${movement.instrument}" movement posts to ${movement.postingAccountCode}; the tender ` +
              `registry says ${expected}`,
          )
        }
      }
    },
  },
  {
    id: 'every-instant-comes-from-the-injected-clock',
    title: 'every instant an adapter reports is the injected clock, never its own',
    why:
      'ADR 0007: nothing here reads the clock, and the reason is reproducibility rather than tidiness. ' +
      'A movement timestamped from `Date.now()` cannot be replayed, which means a disputed payment ' +
      'cannot be reconstructed from the record — and with trading running 11:00 to 02:00 a clock read ' +
      'nine hours either side of midnight puts the takings on the wrong business day.',
    async check(ctx) {
      const opened = await authorised(ctx, 35_000, 'clock')
      if (opened.observedAt !== ctx.at) {
        violate(
          `the snapshot reports observedAt ${String(opened.observedAt)}; the injected clock says ` +
            `${String(ctx.at)}. This adapter is reading its own clock.`,
        )
      }
      for (const movement of ctx.records.all()) {
        if (movement.occurredAt !== ctx.at) {
          violate(
            `the ${movement.operation} movement is stamped ${String(movement.occurredAt)} and the ` +
              `injected clock says ${String(ctx.at)}`,
          )
        }
      }
      const captureAmount = ctx.gateway.capabilities.supportsPartialCapture ? 15_000 : 35_000
      await ctx.gateway.capture({
        gatewayIntentId: opened.gatewayIntentId,
        amount: inFils(captureAmount),
        idempotencyKey: ctx.key('clock-capture'),
      })
      const receipt = await ctx.gateway.refund({
        gatewayIntentId: opened.gatewayIntentId,
        amount: inFils(captureAmount),
        idempotencyKey: ctx.key('clock-refund'),
        reason: 'conformance probe',
      })
      if (receipt.acknowledgedAt !== ctx.at) {
        violate(
          `the refund receipt is acknowledged at ${String(receipt.acknowledgedAt)} and the injected ` +
            `clock says ${String(ctx.at)}`,
        )
      }
    },
  },
  {
    id: 'idempotency-key-replays-the-first-answer',
    title: 'a repeated idempotency key returns the first answer and moves no money a second time',
    why:
      'A retry is the normal case, not the exception: a timeout that succeeded server-side is ' +
      'indistinguishable from one that did not. An adapter that authorises twice for one key charges ' +
      'the customer twice, and the second charge has no invoice behind it.',
    async check(ctx) {
      const key = ctx.key('idem')
      const request = {
        amount: inFils(35_000),
        instrument: ctx.instrument,
        idempotencyKey: key,
        reference: 'CONF-idem',
      }
      const first = await ctx.gateway.authorise(request)
      const second = await ctx.gateway.authorise(request)
      if (first.gatewayIntentId !== second.gatewayIntentId) {
        violate(
          `the same idempotency key produced two intents, ${first.gatewayIntentId} and ` +
            `${second.gatewayIntentId}. The customer has been authorised twice.`,
        )
      }
      const made = realMovements(ctx.records)
      if (made.length !== 1) {
        violate(
          `two calls with one key made ${made.length} movements. A replay may be RECORDED — a replay ` +
            'nobody can see is indistinguishable from a second payment that was lost — but it must be ' +
            'marked `suppressedDuplicate`, and exactly one movement must be unmarked.',
        )
      }
    },
  },
  {
    id: 'refuses-an-instrument-it-does-not-serve',
    title: 'an instrument outside `serves` is refused rather than accepted on the nearest account',
    why:
      'Each instrument posts to its own clearing account, and a gateway that accepted a kind it does ' +
      'not serve would post the money there. The registry resolves instrument to gateway precisely so ' +
      'no caller has to know, which means the refusal is the only thing that catches a wrong answer.',
    async check(ctx) {
      const other = notServed(ctx.gateway)
      await refuses(`authorising a "${other}" tender on ${ctx.gateway.name}`, () =>
        ctx.gateway.authorise({
          amount: inFils(35_000),
          instrument: other,
          idempotencyKey: ctx.key('wrong-instrument'),
          reference: 'CONF-wrong-instrument',
        }),
      )
    },
  },
  {
    id: 'refuses-a-blank-reference',
    title: 'an authorisation with no document reference is refused',
    why:
      'The reference is the only thing tying a movement to an invoice or a booking. A blank one ' +
      'produces a payment that reconciles against nothing, and blank is not absent: an empty string ' +
      'reads as a reference that was not captured rather than one that does not exist.',
    async check(ctx) {
      await refuses('authorising with a blank reference', () =>
        ctx.gateway.authorise({
          amount: inFils(35_000),
          instrument: ctx.instrument,
          idempotencyKey: ctx.key('blank-ref'),
          reference: '   ',
        }),
      )
    },
  },
  {
    id: 'refuses-a-fractional-amount',
    title: 'an amount that is not integer fils is refused at the edge',
    why:
      'ADR 0007. The type system stops a fractional LITERAL; a value that arrived in a request body has ' +
      'been through a cast and the type system is no longer looking. Rounding it here would move real ' +
      'money by a fraction of a fils on every transaction and surface as a VAT reconciliation nobody ' +
      'can close.',
    async check(ctx) {
      await refuses('authorising 12.5 fils', () =>
        ctx.gateway.authorise({
          amount: fractionalAmount(),
          instrument: ctx.instrument,
          idempotencyKey: ctx.key('fractional'),
          reference: 'CONF-fractional',
        }),
      )
    },
  },
  {
    id: 'capture-never-exceeds-authorised',
    title: 'a capture over the authorised amount is refused',
    why:
      'A gateway cannot take more than it reserved, so an over-capture is a mis-routed event or a lost ' +
      'authorisation — never a capture to accept. Accepting one takes money the customer never agreed ' +
      'to, and the excess has no invoice line behind it.',
    async check(ctx) {
      const opened = await authorised(ctx, 35_000, 'over-capture')
      await refuses('capturing 35001 fils against 35000 authorised', () =>
        ctx.gateway.capture({
          gatewayIntentId: opened.gatewayIntentId,
          amount: inFils(35_001),
          idempotencyKey: ctx.key('over-capture-call'),
        }),
      )
    },
  },
  {
    id: 'refund-never-exceeds-captured',
    title: 'a refund over what was captured is refused',
    why:
      'Money that was never taken cannot be given back: the excess is a payment out with no receipt ' +
      'behind it, and it clears the bank before anybody notices the journal does not balance.',
    async check(ctx) {
      const opened = await authorised(ctx, 35_000, 'over-refund')
      await ctx.gateway.capture({
        gatewayIntentId: opened.gatewayIntentId,
        amount: inFils(35_000),
        idempotencyKey: ctx.key('over-refund-capture'),
      })
      await refuses('refunding 35001 fils against 35000 captured', () =>
        ctx.gateway.refund({
          gatewayIntentId: opened.gatewayIntentId,
          amount: inFils(35_001),
          idempotencyKey: ctx.key('over-refund-call'),
          reason: 'conformance probe',
        }),
      )
    },
  },
  {
    id: 'state-follows-the-declared-transition-table',
    title: "every state an adapter reports is one @berelax/core's table reaches by that event",
    why:
      'The table is the one statement of the lifecycle, and Y-PAY-04 folds webhooks through it to ' +
      'converge on a state whatever order they arrive in. An adapter reporting a state the table cannot ' +
      'reach makes that fold disagree with the gateway, and the disagreement shows up as an invoice ' +
      'marked paid for a capture that never happened.',
    async check(ctx) {
      const opened = await authorised(ctx, 35_000, 'states')
      if (!statesAfterAuthorisation().includes(opened.state)) {
        violate(
          `authorise reported state "${opened.state}", which the table cannot reach from ` +
            `"${PAYMENT_INTENT_INITIAL_STATE}". Reachable: ${statesAfterAuthorisation().join(', ')}`,
        )
      }
      if (!isIntentTransitionAllowed(opened.state, 'captured')) return
      const captured = await ctx.gateway.capture({
        gatewayIntentId: opened.gatewayIntentId,
        amount: inFils(ctx.gateway.capabilities.supportsPartialCapture ? 15_000 : 35_000),
        idempotencyKey: ctx.key('states-capture'),
      })
      const expected = nextIntentState(opened.state, 'captured')
      if (captured.state !== expected) {
        violate(
          `a capture on a "${opened.state}" intent reported "${captured.state}"; the table says ` +
            `"${expected}"`,
        )
      }
    },
  },
  {
    id: 'fetch-intent-agrees-with-the-last-answer',
    title: 'fetchIntent returns what the last call returned, to the fils',
    why:
      "Y-PAY-05 reconciles local state against this method's answer, so a `fetchIntent` that disagrees " +
      "with the gateway's own operations turns every intent into a spurious divergence — and a " +
      'reconciliation job that reports 500 repairs it did not need is a job nobody reads.',
    async check(ctx) {
      const opened = await authorised(ctx, 26_250, 'fetch')
      const fetched = await ctx.gateway.fetchIntent(opened.gatewayIntentId)
      const mismatch = (['state', 'instrument', 'postingAccountCode'] as const).find(
        (field) => fetched[field] !== opened[field],
      )
      if (mismatch !== undefined) {
        violate(
          `fetchIntent disagrees on ${mismatch}: ${String(fetched[mismatch])} against ` +
            `${String(opened[mismatch])}`,
        )
      }
      for (const field of ['authorised', 'captured', 'refunded'] as const) {
        if (fetched[field].fils !== opened[field].fils) {
          violate(
            `fetchIntent reports ${field} as ${fetched[field].fils} fils and authorise reported ` +
              `${opened[field].fils}`,
          )
        }
      }
      if (fetched.authorised.fils !== 26_250) {
        violate(
          `an authorisation of 26250 fils reads back as ${fetched.authorised.fils}. The amount did not ` +
            'survive the round trip through this adapter.',
        )
      }
    },
  },
  {
    id: 'amounts-round-trip-through-the-declared-minor-units',
    title: 'every probe amount survives the declared minor-unit convention exactly',
    why:
      'ADR 0007: a gateway on another convention converts at its edge and nowhere else, and a ' +
      'conversion that cannot be made exactly refuses rather than rounding. An adapter whose declared ' +
      'convention cannot carry AED 262.50 loses fifty fils on every transaction, and the loss appears ' +
      'only when somebody reconciles a settlement batch months later.',
    async check(ctx) {
      for (const amount of PROBE_FILS) {
        if (!survivesMinorUnitRoundTrip(inFils(amount), ctx.gateway.minorUnits)) {
          violate(
            `${amount} fils does not survive a round trip through "${ctx.gateway.minorUnits.label}" ` +
              `(exponent ${ctx.gateway.minorUnits.exponent})`,
          )
        }
      }
      for (const amount of PROBE_FILS) {
        const opened = await ctx.gateway.authorise({
          amount: inFils(amount),
          instrument: ctx.instrument,
          idempotencyKey: ctx.key(`round-trip-${amount}`),
          reference: `CONF-round-trip-${amount}`,
        })
        if (opened.authorised.fils !== amount) {
          violate(
            `authorising ${amount} fils reported ${opened.authorised.fils} back. The adapter's own ` +
              'conversion lost or invented fils.',
          )
        }
      }
    },
  },
  {
    id: 'partial-capture-matches-the-declared-capability',
    title: 'a partial capture works if declared and is refused if not',
    why:
      'A capability flag that merely turned a case off would be how an adapter opted out of this ' +
      'contract, and the first adapter to do it would be the real one. So a declared `false` is a ' +
      'refusal the suite demands: an adapter claiming it cannot capture part of an authorisation and ' +
      'then quietly capturing all of it takes the wrong amount and says nothing.',
    async check(ctx) {
      const opened = await authorised(ctx, 35_000, 'partial-capture')
      const call = () =>
        ctx.gateway.capture({
          gatewayIntentId: opened.gatewayIntentId,
          amount: inFils(15_000),
          idempotencyKey: ctx.key('partial-capture-call'),
        })
      if (!ctx.gateway.capabilities.supportsPartialCapture) {
        await refuses('capturing 15000 of 35000 on a gateway declaring no partial capture', call)
        return
      }
      const captured = await call()
      if (captured.captured.fils !== 15_000) {
        violate(
          `a partial capture of 15000 fils reports ${captured.captured.fils} captured, and this gateway ` +
            'declares partial capture supported',
        )
      }
      if (captured.authorised.fils - captured.captured.fils !== 20_000) {
        violate(
          `after capturing 15000 of 35000 the remaining capturable amount is ` +
            `${captured.authorised.fils - captured.captured.fils} fils, not 20000`,
        )
      }
    },
  },
  {
    id: 'partial-refund-matches-the-declared-capability',
    title: 'a partial refund works if declared and is refused if not, and refunds accumulate',
    why:
      'A spa refunds one treatment out of three far more often than a whole invoice, so partial ' +
      'refunds are the normal case and they accumulate. An adapter that forgot the running total lets ' +
      'the same treatment be refunded three times.',
    async check(ctx) {
      const opened = await authorised(ctx, 35_000, 'partial-refund')
      await ctx.gateway.capture({
        gatewayIntentId: opened.gatewayIntentId,
        amount: inFils(35_000),
        idempotencyKey: ctx.key('partial-refund-capture'),
      })
      const half = () =>
        ctx.gateway.refund({
          gatewayIntentId: opened.gatewayIntentId,
          amount: inFils(15_000),
          idempotencyKey: ctx.key('partial-refund'),
          reason: 'conformance probe',
        })
      if (!ctx.gateway.capabilities.supportsPartialRefund) {
        await refuses('refunding 15000 of 35000 on a gateway declaring no partial refund', half)
        return
      }
      await half()
      await half()
      // 30,000 of 35,000 has come back. A third 15,000 would exceed it, and an adapter that had not kept
      // the running total would allow it.
      await refuses('refunding a third 15000 against 35000 captured', half)
    },
  },
  {
    id: 'void-matches-the-declared-capability',
    title: 'a void works if declared, is refused if not, and never releases captured money',
    why:
      'Money that has been taken is refunded, not voided: a void releases a reservation, and doing it ' +
      'to a captured intent leaves the capture unaccounted for. The declared `false` matters just as ' +
      'much — a till that answered a void with success would report a payment as cancelled while the ' +
      'cash was still in the drawer.',
    async check(ctx) {
      const opened = await authorised(ctx, 35_000, 'void')
      const call = (label: string) =>
        ctx.gateway.voidAuthorisation({
          gatewayIntentId: opened.gatewayIntentId,
          idempotencyKey: ctx.key(label),
        })
      if (!ctx.gateway.capabilities.supportsVoid) {
        await refuses('voiding on a gateway declaring no void', () => call('void-call'))
        return
      }
      const voided = await call('void-call')
      if (voided.state !== 'voided') {
        violate(`a void reported state "${voided.state}" rather than "voided"`)
      }
      await refuses('capturing a voided authorisation', () =>
        ctx.gateway.capture({
          gatewayIntentId: opened.gatewayIntentId,
          amount: inFils(35_000),
          idempotencyKey: ctx.key('void-then-capture'),
        }),
      )
      const second = await authorised(ctx, 35_000, 'void-captured')
      await ctx.gateway.capture({
        gatewayIntentId: second.gatewayIntentId,
        amount: inFils(35_000),
        idempotencyKey: ctx.key('void-captured-capture'),
      })
      await refuses('voiding a captured intent', () =>
        ctx.gateway.voidAuthorisation({
          gatewayIntentId: second.gatewayIntentId,
          idempotencyKey: ctx.key('void-captured-void'),
        }),
      )
    },
  },
  {
    id: 'event-emission-matches-the-declared-capability',
    title: 'the event stream is non-empty if events are declared and empty if they are not',
    why:
      'Y-PAY-04 treats webhooks as the only source of truth and Y-PAY-05 resumes from a cursor, so an ' +
      'adapter that declares events and emits none leaves every intent to be repaired by ' +
      'reconciliation — and one that declares none and emits some has a stream nobody is draining.',
    async check(ctx) {
      const opened = await authorised(ctx, 35_000, 'events')
      await ctx.gateway.capture({
        gatewayIntentId: opened.gatewayIntentId,
        amount: inFils(ctx.gateway.capabilities.supportsPartialCapture ? 15_000 : 35_000),
        idempotencyKey: ctx.key('events-capture'),
      })
      const stream = await ctx.gateway.eventsSince(null)
      if (!ctx.gateway.capabilities.emitsEvents) {
        if (stream.length > 0) {
          violate(
            `this gateway declares emitsEvents false and produced ${stream.length} deliveries. A ` +
              'stream nobody is draining is a set of state changes nothing will ever apply.',
          )
        }
        return
      }
      if (stream.length === 0) {
        violate(
          'this gateway declares emitsEvents true and produced nothing after an authorisation and a ' +
            'capture. Every intent would have to be repaired by reconciliation.',
        )
      }
      for (const delivery of stream) {
        if (delivery.gatewayIntentId !== opened.gatewayIntentId) {
          violate(
            `a delivery names intent ${delivery.gatewayIntentId}, which is not the one under test ` +
              `(${opened.gatewayIntentId})`,
          )
        }
        if (!PAYMENT_INTENT_EVENTS.includes(delivery.event.type)) {
          violate(
            `a delivery carries event type "${delivery.event.type}", which the port does not declare`,
          )
        }
      }
      const last = stream[stream.length - 1]
      if (last === undefined) violate('the stream reported a length it does not have')
      const resumed = await ctx.gateway.eventsSince(last?.cursor ?? null)
      if (resumed.length !== 0) {
        violate(
          `resuming from the last cursor returned ${resumed.length} more deliveries. A cursor that does ` +
            'not advance makes a reconciliation job re-apply the whole stream on every run.',
        )
      }

      // The end-to-end claim, and the one that found a defect in `reduceIntent` itself: what the gateway
      // SAYS an intent is, and what the core fold derives from the gateway's own events, must agree. If
      // they did not, Y-PAY-04's webhook path and Y-PAY-05's reconciliation would disagree with each
      // other by construction, and each would look right on its own.
      const folded = reduceIntent(stream.map((delivery) => delivery.event))
      const snapshot = await ctx.gateway.fetchIntent(opened.gatewayIntentId)
      for (const field of ['authorised', 'captured', 'refunded'] as const) {
        if (folded.amounts[field].fils !== snapshot[field].fils) {
          violate(
            `folding this gateway's own event stream gives ${field} = ${folded.amounts[field].fils} fils ` +
              `and the gateway reports ${snapshot[field].fils}. The stream and the answer disagree.`,
          )
        }
      }
      if (folded.state !== snapshot.state) {
        violate(
          `folding this gateway's own event stream gives state "${folded.state}" and the gateway reports ` +
            `"${snapshot.state}"`,
        )
      }
    },
  },
  {
    id: 'external-service-matches-the-declared-capability',
    title: 'an armed failure fires if a service is declared and changes nothing if it is not',
    why:
      'ADR 0022 rule 2: a fake that only ever succeeds hides every error path, and the error paths are ' +
      'most of the work. The other direction matters as much — an adapter with no external service ' +
      'that could be made to fail by a test switch would be one whose failures were fiction, and the ' +
      'till is the adapter that must never have any.',
    async check(ctx) {
      if (!ctx.gateway.capabilities.hasExternalService) {
        ctx.failures.failAlways('server_error')
        try {
          await authorised(ctx, 35_000, 'no-service')
        } catch (error) {
          violate(
            `this gateway declares no external service and yet an armed failure reached it: ` +
              `${String(error)}. There is nothing to call, so there is nothing that can fail.`,
          )
        } finally {
          ctx.failures.clear()
        }
        return
      }
      ctx.failures.clear().failNext('server_error')
      const error = await refuses('an authorisation with server_error armed', () =>
        authorised(ctx, 35_000, 'armed'),
      )
      if (failureModeOf(error) !== 'server_error') {
        violate(
          `the armed failure surfaced as ${String(failureModeOf(error))} rather than server_error, so a ` +
            'retry policy cannot branch on it without parsing prose',
        )
      }
      ctx.failures.clear()
      await authorised(ctx, 35_000, 'after-armed')
    },
  },
])

/** The rules, as metadata. What a gate case and a report iterate. */
export const CONFORMANCE_RULES: readonly ConformanceRule[] = Object.freeze(
  RULES.map(({ id, title, why }) => Object.freeze({ id, title, why })),
)

/** Every rule id, sorted. For an assertion that no rule was skipped. */
export const CONFORMANCE_RULE_IDS: readonly string[] = Object.freeze(
  [...RULES.map((rule) => rule.id)].sort(),
)

/**
 * Runs every rule against one candidate and reports per rule.
 *
 * Each rule gets a FRESH adapter, sink and failure script. Sharing one would make a rule's result depend
 * on what the rules before it had done to the adapter — which is how a suite comes to pass in one order and
 * fail in another, and the failure then looks like flakiness rather than like coupling.
 *
 * Nothing throws out of here. A rule that breaks records a failure, and the run continues, so one report
 * names every rule an adapter breaks rather than the first.
 */
export async function runPaymentGatewayConformance(
  candidate: ConformanceCandidate,
): Promise<ConformanceReport> {
  const results: ConformanceRuleResult[] = []

  for (const rule of RULES) {
    const clock = fixedClock(PINNED_ISO)
    const records = createRecordSink()
    const failures = new FailureScript()
    let counter = 0
    const gateway = candidate.build({ clock, records, failures })

    try {
      const served = gateway.serves[0]
      if (served === undefined) {
        violate(
          `${candidate.name} serves no tender kind at all, so nothing can be routed to it. A gateway ` +
            'with an empty `serves` is unreachable through the registry and untestable here.',
        )
      }
      await rule.check({
        gateway,
        records,
        failures,
        at: clock.now(),
        // The first kind the gateway serves. Every positive path is exercised with it, so an adapter
        // cannot pass by declaring one instrument and working for another.
        instrument: served as TenderKind,
        key(label: string) {
          counter += 1
          return `conf-${rule.id}-${label}-${String(counter)}` as IdempotencyKey
        },
      })
      results.push(Object.freeze({ ruleId: rule.id, passed: true, detail: '' }))
    } catch (error) {
      results.push(
        Object.freeze({
          ruleId: rule.id,
          passed: false,
          detail: error instanceof Error ? error.message : String(error),
        }),
      )
    }
  }

  const failed = Object.freeze(
    results
      .filter((result) => !result.passed)
      .map((result) => result.ruleId)
      .sort(),
  )
  return Object.freeze({
    candidate: candidate.name,
    results: Object.freeze(results),
    failed,
    conforms: failed.length === 0,
  })
}

/** A one-line summary of a report, for a failure message that has to fit on a terminal. */
export function describeReport(report: ConformanceReport): string {
  if (report.conforms) return `${report.candidate}: conforms (${report.results.length} rules)`
  return (
    `${report.candidate}: ${report.failed.length} of ${report.results.length} rules failed —\n` +
    report.results
      .filter((result) => !result.passed)
      .map((result) => `  ${result.ruleId}: ${result.detail}`)
      .join('\n')
  )
}
