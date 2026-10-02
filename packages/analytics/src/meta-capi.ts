/**
 * The Meta Conversions API adapter — a named fake, because there is no Meta pixel (A-MEAS-03).
 *
 * ## The body is real; the transport is not
 *
 * `metaConversionsBody` builds exactly the document the Conversions API accepts: a `data` array of events,
 * each with `event_name`, `event_time` in whole SECONDS, `event_id`, `action_source`, and a `user_data`
 * object of hashed match keys. That shape is what a port exists to pin down and it is checkable with no
 * account at all.
 *
 * There is no dataset id, no access token and no endpoint in this module (OPEN-QUESTIONS
 * `Y1-analytics-credentials`), so nothing is transmitted and `scripts/check-egress-guard.mjs`'s
 * `DECLARED_ADAPTERS` is still empty after this unit — the honest state while no module names a door out
 * of the building. `./registry.ts` resolves `real` to `notImplemented`.
 *
 * ## `event_time` is SECONDS and GA4's is microseconds, and that is why both are written out
 *
 * The two platforms disagree about the unit of the one field whose being wrong is completely silent.
 * Milliseconds into Meta's `event_time` is a conversion in the year 56,000 and is rejected; SECONDS into
 * GA4's `timestamp_micros` is a conversion in January 1970 and is ACCEPTED. So each adapter converts in
 * its own module, from the same validated `Date`, rather than the port carrying one number both read —
 * which would make one of the two wrong by construction and neither obviously so.
 *
 * The window is the second thing about `event_time` and it is A-MEAS-05's: Meta accepts an event up to a
 * documented age and rejects an older one, and that figure is not written down anywhere in this build
 * because nobody has it from the platform. {@link META_PAST_EVENT_WINDOW_IS_AN_OPEN_QUESTION} says so
 * rather than a plausible number standing in for it (brief rule 15).
 *
 * ## `user_data` carries hashes and `fbp`/`fbc` verbatim, and nothing else
 *
 * The keys are Meta's own: `ph`, `em`, `fbp`, `fbc`. The first two are SHA-256 lowercase hex, produced by
 * `hashedUserData` in `./identity.ts` before this adapter sees them — the port's type is
 * {@link HashedUserData}, whose fields are named `phoneSha256` and `emailSha256`, so an adapter cannot be
 * handed a plaintext number to forget to hash. The last two pass through unchanged, because they are
 * Meta's own cookie values: already opaque to us, unmatchable if hashed, and the only thing that joins a
 * server-side conversion to the click that produced it.
 *
 * An absent key is ABSENT and never present-and-null. Meta treats a null match key as a key that matched
 * nobody, which is a different report from no key at all — and `exactOptionalPropertyTypes` is what keeps
 * the two apart at the type level.
 */
import { conversionValueNumber } from '@berelax/core'
import { type AnalyticsFakeContext, dispatchEventTime, performFakeDispatch } from './fakes.ts'
import type {
  AnalyticsDispatchAccepted,
  AnalyticsDispatchProvider,
  AnalyticsDispatchRequest,
  HashedUserData,
  LocalDispatchRecord,
} from './port.ts'

export const META_CONVERSIONS_API = Object.freeze({
  name: 'meta-conversions-api',
  /** The destination id this adapter serves, from `CONSENT_GATED_TARGETS`. Opaque: it names no host. */
  destination: 'advertising_conversion_push',
})

/**
 * The past-event window, which this build does not know.
 *
 * Meta rejects an offline conversion older than a documented age. The figure is the platform's and nobody
 * has it on file here, so A-MEAS-05 does not clamp, truncate or warn against a number: it carries the real
 * past instant and leaves the window as an open question. A guessed window is worse than none — it either
 * silently drops conversions that would have been accepted, or passes ones that will be rejected while
 * this build records them as sent.
 */
export const META_PAST_EVENT_WINDOW_IS_AN_OPEN_QUESTION =
  "The platform's accepted age for a past event is not on file in this build " +
  '(OPEN-QUESTIONS Y1-analytics-credentials). No window is assumed: the real instant of the visit is ' +
  'carried, and a conversion rejected for age is a refusal to record rather than a number to guess.'

/** The `user_data` object, in Meta's own key names. Absent fields are absent. */
export function metaUserData(userData: HashedUserData): Readonly<Record<string, string>> {
  const out: Record<string, string> = {}
  if (userData.phoneSha256 !== undefined) out['ph'] = userData.phoneSha256
  if (userData.emailSha256 !== undefined) out['em'] = userData.emailSha256
  if (userData.fbp !== undefined) out['fbp'] = userData.fbp
  if (userData.fbc !== undefined) out['fbc'] = userData.fbc
  return Object.freeze(out)
}

/**
 * The Conversions API body for one dispatch. Pure, and built field by field from the branded payload.
 *
 * No spread of the request and no spread of the payload anywhere in this module — the shape
 * `scripts/check-egress-guard.mjs` rule 2 exists to keep, because a spread carries whatever a caller
 * happened to be holding and every drop counter reads zero while every field travels.
 */
export function metaConversionsBody(
  request: AnalyticsDispatchRequest,
): Readonly<Record<string, unknown>> {
  const fields = request.payload as unknown as Readonly<Record<string, unknown>>
  const event: Record<string, unknown> = {
    event_name: fields['eventType'],
    // WHOLE seconds. `Math.floor` and not `Math.round`: rounding up puts an event a fraction of a second
    // into the future, and a future event_time is the one value Meta rejects outright.
    event_time: Math.floor(dispatchEventTime(request).getTime() / 1000),
    event_id: request.eventId,
    action_source: request.actionSource,
    user_data: metaUserData(request.userData),
    custom_data: metaCustomData(fields),
  }
  return Object.freeze({ data: [event] })
}

/** The payload's own fields, under Meta's `custom_data`. The opaque code, never a service name. */
function metaCustomData(
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const custom: Record<string, unknown> = {
    content_category: fields['categoryCode'],
    // Meta's own key for the count. `num_items` and not `quantity`, which is GA4's.
    num_items: fields['quantity'],
  }
  const valueFils = fields['valueFils']
  if (typeof valueFils === 'number') {
    custom['value'] = conversionValueNumber(valueFils)
    custom['currency'] = fields['currency']
  }
  return Object.freeze(custom)
}

/**
 * The named fake. Builds the real body, transmits nothing, and records what it would have posted.
 *
 * Named after the product for the reason `createFakeSmsala` is: a fake named after the interface is one
 * nobody notices is standing in for a specific vendor, and the body above is Meta-shaped rather than
 * generic.
 */
export function createFakeMetaConversionsApi(
  context: AnalyticsFakeContext,
): AnalyticsDispatchProvider {
  const name = META_CONVERSIONS_API.name
  return {
    name,
    async send(request: AnalyticsDispatchRequest): Promise<AnalyticsDispatchAccepted> {
      const { record, decision } = await performFakeDispatch(
        context,
        name,
        request,
        metaConversionsBody(request),
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
