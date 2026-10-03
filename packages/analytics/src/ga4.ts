/**
 * The GA4 Measurement Protocol adapter — a named fake, because there is no GA4 property (A-MEAS-03).
 *
 * ## What is fake here and what is not
 *
 * The BODY is real. `ga4MeasurementBody` builds exactly the document the Measurement Protocol accepts —
 * one `events` array of `{ name, params }`, the currency beside the value, the event id in `params` — out
 * of an {@link EgressPayload} and nothing else. That shape is the part a port exists to pin down, and it
 * is checkable with no account: `ga4.test.ts` asserts the body's own keys, and
 * `packages/fixtures/src/analytics-dispatch.itest.ts` asserts no token outside the permitted vocabulary
 * appears in its serialisation.
 *
 * What is fake is the TRANSPORT. There is no measurement id, no API secret and no endpoint in this module
 * — OPEN-QUESTIONS `Y1-analytics-credentials` is open and `docs/01` decision 14 has not been answered — so
 * the adapter records the body it would have posted in the shared local outbox and returns
 * `transmitted: false`. `scripts/check-egress-guard.mjs` rule 6 refuses any module naming an analytics
 * destination host outside `DECLARED_ADAPTERS`, and that map is still EMPTY after this unit, which is the
 * honest state: nothing in this repository names a door out of the building, because nothing transmits.
 * `createProviders`-style selection resolves `real` to `notImplemented` in `./registry.ts`.
 *
 * ## Why the event name is the funnel stage and nothing is mapped onto GA4's recommended events
 *
 * GA4 has recommended event names (`purchase`, `view_item`) and the tempting thing is to map the funnel
 * onto them. A-MEAS-01's rule 7 refuses it and `scripts/check-egress-guard.mjs` enforces it: the
 * dispatchable event types ARE `FUNNEL_STAGES`, derived, because a platform optimising on a signal the
 * funnel does not hold is optimising on something this business cannot reconcile against the journal. A
 * mapping would also be a second vocabulary to keep in step, and the first stage to drift would be the one
 * nobody checks.
 *
 * ## `value` is a decimal and the conversion happens here, once
 *
 * Money is integer fils everywhere inside this build (ADR 0007) and GA4's `value` is a decimal in the
 * currency's major unit. `filsToMajorUnits` in `@berelax/core` is the one conversion and both adapters
 * call it, so the two platforms cannot be told two different figures for one conversion — which is a
 * variance A-MEAS-07 would report and nobody could attribute.
 */
import { conversionValueNumber, type EgressPayload } from '@berelax/core'
import { type AnalyticsFakeContext, dispatchEventTime, performFakeDispatch } from './fakes.ts'
import type {
  AnalyticsDispatchAccepted,
  AnalyticsDispatchProvider,
  AnalyticsDispatchRequest,
  LocalDispatchRecord,
} from './port.ts'

/** The adapter's name, used on every outbox row and in every refusal. */
export const GA4_MEASUREMENT_PROTOCOL = Object.freeze({
  name: 'ga4-measurement-protocol',
  /** The destination id this adapter serves, from `CONSENT_GATED_TARGETS`. Opaque: it names no host. */
  destination: 'analytics_measurement_push',
} as const)

/**
 * Why `client_id` is absent from every body this build produces.
 *
 * Recorded as a field on the body rather than left out silently, which is the whole of brief rule 15
 * applied to a payload: an absent key reads as "this build has no browser identifier", and a plausible
 * one would read as configured. A made-up client id is also actively destructive — each one is a distinct
 * visitor to GA4, so a run of invented ids reports every conversion as a first-ever session.
 */
export const GA4_CLIENT_REFERENCE_OMITTED =
  'no client_id: the _ga cookie is minted by the on-page tag (A-MEAS-04), and an offline conversion ' +
  'never had a browser. OPEN-QUESTIONS Y1-analytics-credentials.'

/**
 * The Measurement Protocol body for one dispatch.
 *
 * Exported and pure, so the shape is assertable without an adapter, a clock or a guard. Every value comes
 * from the branded payload or from an explicit argument of the request — there is no `...request` spread
 * anywhere in this module, which is the shape `scripts/check-egress-guard.mjs` rule 2 exists to keep:
 * a spread would carry whatever a caller happened to be holding and every drop counter would read zero.
 */
export function ga4MeasurementBody(
  request: AnalyticsDispatchRequest,
): Readonly<Record<string, unknown>> {
  const fields = request.payload as unknown as Readonly<Record<string, unknown>>
  const eventType = fields['eventType']
  const params: Record<string, unknown> = {
    // GA4 does not deduplicate on it, and it is sent anyway: it is the one value that lets the on-page
    // tag's event and this one be recognised as the same conversion by anybody reading both.
    event_id: request.eventId,
    // The opaque category code, never a service name (ADR 0018, ADR 0059).
    item_category: fields['categoryCode'],
    quantity: fields['quantity'],
    // The event's own instant in GA4's unit — MICROseconds, which is the one unit mistake that is
    // silent: milliseconds here dates every conversion in 1970 and GA4 accepts it.
    timestamp_micros: dispatchEventTime(request).getTime() * 1000,
    action_source: request.actionSource,
  }
  const valueFils = fields['valueFils']
  if (typeof valueFils === 'number') {
    params['value'] = conversionValueNumber(valueFils)
    params['currency'] = fields['currency']
  }
  const body: Record<string, unknown> = {
    events: [{ name: eventType, params }],
  }
  if (request.clientReference !== undefined) body['client_id'] = request.clientReference
  else body['client_id_omitted'] = GA4_CLIENT_REFERENCE_OMITTED
  return Object.freeze(body)
}

/**
 * The named fake. Builds the real body, transmits nothing, and records what it would have posted.
 *
 * `createFakeGa4MeasurementProtocol` rather than `createFakeAnalytics`, for the reason
 * `createFakeSmsala` and `createFakeDeepSeek` are named after their vendors: a fake named after the
 * interface is a fake nobody notices is standing in for a specific product, and the body above is
 * GA4-shaped rather than generic.
 */
export function createFakeGa4MeasurementProtocol(
  context: AnalyticsFakeContext,
): AnalyticsDispatchProvider {
  const name = GA4_MEASUREMENT_PROTOCOL.name
  return {
    name,
    async send(request: AnalyticsDispatchRequest): Promise<AnalyticsDispatchAccepted> {
      const { record, decision } = await performFakeDispatch(
        context,
        name,
        request,
        ga4MeasurementBody(request),
      )
      return {
        provider: name,
        transmitted: decision.kind === 'transmit',
        divertedReason: decision.kind === 'divert' ? decision.reason : null,
        outboxId: record.outboxId,
      }
    },
    drainLocalOutbox(): readonly LocalDispatchRecord[] {
      return context.outbox.forProvider(name)
    },
  }
}

/** Re-exported so a consumer need not import the payload type from two places. */
export type { EgressPayload }
