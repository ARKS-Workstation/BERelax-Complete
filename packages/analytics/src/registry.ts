/**
 * Analytics dispatcher selection, from configuration only (A-MEAS-03, ADR 0005, ADR 0022).
 *
 * docs/12 §1.3: *a feature flag defaulting to the fake, flipped by config, never by a code change.* This
 * is that flag for the two analytics destinations, and it is the only module in this package that
 * constructs an adapter — `.dependency-cruiser.cjs`'s `analytics-adapters-only-through-the-registry`
 * refuses an import of `./ga4.ts` or `./meta-capi.ts` from anywhere else, and
 * `scripts/test-boundaries.mjs` proves that rule rejects one by name (ADR 0003).
 *
 * The reason that rule exists is the reason `payment-gateway-adapters-only-through-the-registry` exists,
 * one subject along: a consumer that imported `createFakeGa4MeasurementProtocol` directly would keep using
 * the fake in production with nothing saying so. `parseConfig` would still refuse `ANALYTICS_PROVIDER=real`
 * outside production and `notImplemented` would still throw for `real` — and the conversions would still
 * go nowhere, because that call site never asked the configuration anything.
 *
 * **THE BARREL IS THE LOOPHOLE**, and it is closed harder than the payments one: `./index.ts` does not
 * reach either adapter module AT ALL, not even for a constant, because a re-export of ANY kind makes a
 * module-matching rule match nothing — so there is no shorter list to keep right. A consumer names a
 * destination through {@link DISPATCH_DESTINATIONS}, which this module assembles, and a test that needs a
 * body builder imports the adapter directly, which the rule permits for a test and for nothing else.
 *
 * ## Two destinations and one registry, not one adapter per destination
 *
 * {@link AnalyticsDispatchers} is keyed on the DESTINATION id — `analytics_measurement_push` and
 * `advertising_conversion_push`, which are `CONSENT_GATED_TARGETS`' own keys — rather than on the vendor.
 * That is what makes the consumer able to take a dispatch row, read its `destination` column and get an
 * adapter without a branch: the column is written by the gate (0125) and the gate's vocabulary is the one
 * thing both halves already agree on. A registry keyed on the vendor would need a second mapping from
 * destination to vendor, which is a second statement of a fact that drifts.
 *
 * ## `real` throws rather than degrading, and it throws at construction
 *
 * There is no GA4 property and no Meta pixel (OPEN-QUESTIONS `Y1-analytics-credentials`), so `real`
 * resolves to `notImplemented`, which throws immediately naming the unit that will build it and what it
 * needs first. A registry that quietly fell back to the fake would give a production deploy that looks
 * connected and pushes nothing — the worse of the two failures, because the dispatch rows would say
 * `sent`.
 */
import type { Config } from '@berelax/config'
import { notImplemented } from '@berelax/providers/not-implemented'
import { AppError } from '@berelax/shared'
import { createDispatchOutbox, type DispatchOutbox, TransportScript } from './fakes.ts'
import { createFakeGa4MeasurementProtocol, GA4_MEASUREMENT_PROTOCOL } from './ga4.ts'
import { createFakeMetaConversionsApi, META_CONVERSIONS_API } from './meta-capi.ts'
import type { AnalyticsDispatchProvider } from './port.ts'

/** The destination ids this package serves, which are `CONSENT_GATED_TARGETS`' server-dispatch keys. */
export const DISPATCH_DESTINATIONS = [
  GA4_MEASUREMENT_PROTOCOL.destination,
  META_CONVERSIONS_API.destination,
] as const
export type DispatchDestination = (typeof DISPATCH_DESTINATIONS)[number]

export interface AnalyticsDispatchers {
  /** An adapter by destination id. Throws for an id no adapter serves, rather than returning one. */
  forDestination(destination: string): AnalyticsDispatchProvider
  /** Every adapter, so a conformance assertion can enumerate rather than list. */
  readonly all: readonly AnalyticsDispatchProvider[]
  /** The shared local outbox both adapters write to. One inbox for the owner and for a test. */
  readonly outbox: DispatchOutbox
  /** Arm a transport refusal. Shared, because a rate limit hits everything at once. */
  readonly script: TransportScript
}

export interface AnalyticsRegistryOptions {
  readonly config: Config
  /** Injected, because nothing in this codebase reads the clock directly. */
  readonly now: () => string
  /** Supply a shared outbox when several registries must write to one inbox; otherwise one is made. */
  readonly outbox?: DispatchOutbox
  readonly script?: TransportScript
}

export function createAnalyticsDispatchers(
  options: AnalyticsRegistryOptions,
): AnalyticsDispatchers {
  const { config, now } = options
  const outbox = options.outbox ?? createDispatchOutbox(now)
  const script = options.script ?? new TransportScript()
  const context = { appEnv: config.APP_ENV, now, outbox, script }

  const real = config.ANALYTICS_PROVIDER === 'real'
  const ga4 = real
    ? notImplemented(GA4_MEASUREMENT_PROTOCOL.name)
    : createFakeGa4MeasurementProtocol(context)
  const meta = real
    ? notImplemented(META_CONVERSIONS_API.name)
    : createFakeMetaConversionsApi(context)

  const byDestination: Readonly<Record<DispatchDestination, AnalyticsDispatchProvider>> =
    Object.freeze({
      [GA4_MEASUREMENT_PROTOCOL.destination]: ga4,
      [META_CONVERSIONS_API.destination]: meta,
    })

  return {
    forDestination(destination: string): AnalyticsDispatchProvider {
      const adapter = (
        byDestination as Readonly<Record<string, AnalyticsDispatchProvider | undefined>>
      )[destination]
      if (adapter !== undefined) return adapter
      /*
       * A destination with no adapter THROWS rather than being skipped. Skipping is the fail-quiet an id
       * typo would reach, and the row would stay `queued` for ever with nothing saying why — which looks
       * exactly like a consumer that stopped running. `analytics_dispatch_destination` is the table the
       * gate reads, so a destination that exists there and not here is a deployment somebody has to
       * finish, not a row to leave behind.
       */
      throw new AppError(
        'provider_unavailable',
        `No analytics adapter serves destination '${destination}'. The ids that resolve today are ` +
          `${DISPATCH_DESTINATIONS.join(' | ')}. A dispatch for an unserved destination is refused ` +
          'rather than skipped: a skipped row stays queued for ever and reads exactly like a consumer ' +
          'that stopped running.',
        { details: { destination, served: [...DISPATCH_DESTINATIONS] } },
      )
    },
    all: Object.freeze([ga4, meta]),
    outbox,
    script,
  }
}
