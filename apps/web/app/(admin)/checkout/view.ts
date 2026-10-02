import type { CheckoutRefusal, HostedFieldsConfiguration } from '@berelax/payments'
import type { AdminChrome } from '../../../src/components/admin/google-reauth-banner.ts'

/**
 * The card checkout's paths and its view (Y-PAY-03).
 *
 * The field names and the refusal vocabulary are deliberately NOT here: they are
 * `CHECKOUT_FIELDS`, `CHECKOUT_REFUSALS` and `CHECKOUT_REFUSAL_SENTENCES` in
 * `packages/payments/src/checkout.ts`, because the endpoint the gateway's script posts to reads the same names
 * and the same refusals, and two homes for them is how one transport comes to accept a field the other does
 * not. `reviews/paste/view.ts` keeps its own for the opposite reason — nothing but that screen reads them.
 *
 * What IS here is what only the SCREEN needs: the two paths and the shape the document renders from.
 */

/** The screen. One constant, so the registry entry, the admin prefix and the form's action cannot disagree. */
export const CHECKOUT_PATH = '/checkout'

/** The JSON twin of this screen's POST, for the gateway's own script. Under `/api/v1` like every endpoint. */
export const PAYMENTS_TOKEN_PATH = '/api/v1/payments/token'

/** What the screen shows about an intent it has just created. */
export interface CheckoutOutcomeView {
  readonly paymentIntentId: string
  readonly state: string
  readonly outcome: 'created' | 'replayed'
  readonly authorisedFils: number
  readonly capturedFils: number
  /** True only while the gateway is waiting for the customer to finish a challenge. */
  readonly customerActionRequired: boolean
}

/** Everything the checkout document is rendered from. Pure data: no clock, no connection, no config read. */
export interface CheckoutView {
  readonly chrome: AdminChrome
  /** The instant the page was read at, printed so a stale screenshot is visible as one. */
  readonly readAtIso: string
  /** The gateway's origins, or the keys that are unset. Decides whether a frame is rendered at all. */
  readonly hostedFields: HostedFieldsConfiguration
  /** The gateway the registry built, by name. Never a name this configuration did not construct. */
  readonly gatewayName: string
  /** A fresh key for this attempt, minted by the handler so the form does not have to. */
  readonly idempotencyKey: string
  readonly form: {
    readonly amountFils: string
    readonly reference: string
  }
  readonly refusal: { readonly name: CheckoutRefusal; readonly sentence: string } | null
  readonly outcome: CheckoutOutcomeView | null
  /** What the audit row will name. Null when the screen is rendered outside a session. */
  readonly actorLabel: string | null
}
