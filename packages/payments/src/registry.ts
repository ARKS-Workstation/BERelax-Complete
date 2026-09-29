import type { Config } from '@berelax/config'
import type { Clock, PaymentGateway, PaymentRecordSink, TenderKind } from '@berelax/core'
import { TENDER_KINDS, TENDER_TYPES } from '@berelax/core'
import { FailureScript } from '@berelax/providers/failure'
import { notImplemented } from '@berelax/providers/not-implemented'
import { AppError } from '@berelax/shared'
import { createFakeCardGateway } from './adapters/fake-card.ts'
import { createManualGateway } from './adapters/manual.ts'
import { createRecordSink } from './record-sink.ts'

/**
 * The one place a payment gateway is constructed, and the only place `PAYMENT_PROVIDER` is read.
 *
 * ADR 0022 rule 3 — *selection is configuration, and `real` refuses rather than degrading* — applied to
 * payments. Two guarantees hold by construction rather than by care:
 *
 * **`real` outside production is impossible.** `parseConfig` refuses it before this function runs
 * (ADR 0005), so no staging environment can reach a live merchant account however it is configured. That
 * refusal is asserted for `PAYMENT_PROVIDER` specifically in `packages/payments/src/registry.test.ts`, not
 * only for the provider set as a whole: a check that proved the rule for SMS and assumed it for payments is
 * the shape this repository keeps paying for.
 *
 * **`real` resolves to something that throws at construction.** `notImplemented('card-gateway')` names the
 * unit and what it needs — a chosen gateway, a merchant account and an MCC, none of which exist. A registry
 * that quietly fell back to the fake would give a production deploy that looks connected and takes no money,
 * and the first evidence would be customers who were charged nothing being sent a receipt.
 *
 * ## Why the mapping is instrument-first
 *
 * `byInstrument` is what a consumer actually asks: it holds a `TenderKind` and needs the gateway that takes
 * it. Nothing in the application asks for "the card gateway" by name, which is the point — that is what makes
 * choosing a real provider a configuration change. `registry.test.ts` asserts the mapping is total and
 * unambiguous over `TENDER_KINDS` in both directions, so a tender kind no gateway serves, or one two
 * gateways both claim, fails the build rather than being resolved by whichever was checked first.
 */

export interface PaymentGatewayRegistryOptions {
  readonly config: Config
  /** Injected, because nothing in this estate reads the clock directly (ADR 0007). */
  readonly clock: Clock
  /** Supply one when several registries must write to a single payments screen; otherwise one is made. */
  readonly records?: PaymentRecordSink
  /** Shared with `@berelax/providers` so one `failNext` arms every provider at once. */
  readonly failures?: FailureScript
}

export interface PaymentGatewayRegistry {
  /** Cash, the in-salon card machine and a bank transfer. Real in every environment. */
  readonly till: PaymentGateway
  /** Online cards. The H02 fake until a gateway is chosen; `real` refuses at construction. */
  readonly cards: PaymentGateway
  /** Every gateway, which is what the conformance suite walks. */
  readonly all: readonly PaymentGateway[]
  /** The gateway that takes this tender kind. Throws for one nothing serves. */
  byInstrument(instrument: TenderKind): PaymentGateway
  /** Every movement any gateway recorded, in order. The payments screen and the tests read this. */
  readonly records: PaymentRecordSink
  readonly failures: FailureScript
}

/** Raised when a tender kind reaches the registry and no gateway declares it. */
export class NoGatewayServesInstrument extends AppError {
  constructor(instrument: TenderKind, served: readonly TenderKind[]) {
    super(
      'provider_unavailable',
      `NoGatewayServesInstrument: no gateway in this registry takes "${instrument}". The gateways ` +
        `present serve ${served.join(', ')}. A tender kind with no gateway is a kind the till can offer ` +
        'and nothing can take, so this refuses rather than picking the nearest one.',
      { details: { instrument, served, adapter: TENDER_TYPES[instrument].adapter } },
    )
    this.name = 'NoGatewayServesInstrument'
  }
}

export function createPaymentGateways(
  options: PaymentGatewayRegistryOptions,
): PaymentGatewayRegistry {
  const { config, clock } = options
  const records = options.records ?? createRecordSink()
  const failures = options.failures ?? new FailureScript()

  // Real in every environment, because cash taken at the desk is recorded rather than sent anywhere and a
  // fake till would make the ledger fictional (ADR 0022).
  const till = createManualGateway({ clock, records })

  const cards: PaymentGateway =
    config.PAYMENT_PROVIDER === 'real'
      ? notImplemented('card-gateway')
      : createFakeCardGateway({ clock, records, failures })

  const all: readonly PaymentGateway[] = Object.freeze([till, cards])

  return {
    till,
    cards,
    all,
    byInstrument(instrument: TenderKind): PaymentGateway {
      return resolveGateway(all, instrument)
    },
    records,
    failures,
  }
}

/**
 * The gateway serving one instrument, or a refusal. Exported because the registry's own method closes over
 * its gateway list, and a test needs to drive the two refusals with a list that has them in it.
 *
 * Neither refusal is reachable from a correctly built registry, which is exactly why they are tested through
 * this function rather than through `byInstrument`: a test that had to break the registry to reach them
 * would be testing a registry nobody ships.
 */
export function resolveGateway(
  gateways: readonly PaymentGateway[],
  instrument: TenderKind,
): PaymentGateway {
  const serving = gateways.filter((gateway) => gateway.serves.includes(instrument))
  if (serving.length === 1) return serving[0] as PaymentGateway
  if (serving.length === 0) {
    throw new NoGatewayServesInstrument(
      instrument,
      gateways.flatMap((gateway) => [...gateway.serves]),
    )
  }
  // Two gateways claiming one instrument is a build defect, not a runtime choice: `resolveTarget`'s lesson
  // is that ordering by anything at all makes the answer depend on which was registered first, and a
  // payment sent to the wrong gateway posts to the wrong clearing account.
  throw new AppError(
    'invariant_violated',
    `${serving.length} gateways claim "${instrument}": ` +
      `${serving.map((gateway) => gateway.name).join(', ')}. Exactly one must, and choosing between them ` +
      'here would put the money in whichever clearing account happened to be registered first.',
    { details: { instrument, gateways: serving.map((gateway) => gateway.name) } },
  )
}

/**
 * Every tender kind, with the gateway name that must serve it. Derived from the registry, for tests.
 *
 * Exported so `registry.test.ts` can assert totality without reimplementing the walk, and so a reader can
 * see the mapping in one call rather than inferring it from four `serves` arrays.
 */
export function instrumentCoverage(
  registry: PaymentGatewayRegistry,
): Readonly<Record<TenderKind, readonly string[]>> {
  const coverage = {} as Record<TenderKind, readonly string[]>
  for (const kind of TENDER_KINDS) {
    coverage[kind] = registry.all
      .filter((gateway) => gateway.serves.includes(kind))
      .map((gateway) => gateway.name)
  }
  return Object.freeze(coverage)
}
