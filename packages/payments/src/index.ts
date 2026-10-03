/**
 * @berelax/payments — the payment gateway adapters, one registry, and the suite that makes "adapter" mean
 * something (ADR 0055).
 *
 * The port itself is in `@berelax/core/payments`: types and pure state logic, no clock and no I/O. This
 * package is the only place an adapter is constructed, and the only place `PAYMENT_PROVIDER` is read.
 *
 * The conformance suite is deliberately NOT exported from here. It is reached at
 * `@berelax/payments/conformance`, because it is a test-time and boot-time contract rather than part of the
 * surface a consumer uses, and because the saboteur fixtures sit beside it — a broken adapter that could be
 * imported from the package root is a broken adapter somebody will eventually register.
 */

/**
 * TYPES from the adapters, and no constructor.
 *
 * `payment-gateway-adapters-only-through-the-registry` matches MODULES, and a barrel re-export defeats a
 * module-matching rule completely — which is the loophole `messaging-providers-only-inside-a-transport`
 * found the hard way and now closes the same way. A type constructs nothing, so the rule exempts a
 * type-only edge exactly as `google-tokens-only-in-with-google` exempts `SealedToken`: without that
 * exemption the rule would force a pointless type move or, far likelier, be relaxed to nothing.
 *
 * `FakeCardGateway` is here because it carries `completeCustomerAction` — the fake's stand-in for a
 * customer returning from a 3DS challenge — and Y-PAY-03's checkout screens will need to narrow
 * `registry.cards` to it to demo the challenge path. A consumer that wants a gateway's NAME reads
 * `registry.till.name`, which cannot name a gateway this configuration did not build.
 */
export type { FakeCardGateway, FakeCardGatewayOptions } from './adapters/fake-card.ts'
/**
 * The checkout boundary (Y-PAY-03): the one place a card-payment submission is read and refused.
 *
 * Exported from the root, unlike the conformance suite, because it IS the surface a consumer uses — the
 * `/checkout` screen and `/api/v1/payments/token` both call `authoriseCheckout` and nothing else. It
 * constructs no adapter (it takes the registry), so
 * `payment-gateway-adapters-only-through-the-registry` is satisfied rather than exempted.
 */
export {
  authoriseCheckout,
  CHECKOUT_FIELD_NAMES,
  CHECKOUT_FIELDS,
  CHECKOUT_INSTRUMENT,
  CHECKOUT_REFUSAL_SENTENCES,
  CHECKOUT_REFUSALS,
  type CheckoutBody,
  type CheckoutDeps,
  type CheckoutOutcome,
  type CheckoutParse,
  type CheckoutRefusal,
  type CheckoutSubmission,
  parseCheckoutSubmission,
} from './checkout.ts'
/**
 * The hosted-fields origins and the checkout's content-security policy.
 *
 * A pure function of configuration, exported so the route can set a header it did not assemble and a test can
 * state the whole expected policy. A policy built inline in a handler is a policy nothing can assert the value
 * of, which is how a directive comes to be widened by a line that looks like configuration.
 */
export {
  checkoutContentSecurityPolicy,
  HOSTED_FIELDS_FRAME_ORIGIN_KEY,
  HOSTED_FIELDS_OPEN_QUESTION,
  HOSTED_FIELDS_SCRIPT_ORIGIN_KEY,
  type HostedFieldsConfiguration,
  type HostedFieldsOrigins,
  hostedFieldsFrom,
  isHostedFieldsOrigin,
  permittedOrigins,
} from './hosted-fields.ts'
/**
 * The intent service: where the pure lifecycle in `@berelax/core` and the durable rows in `@berelax/db` meet.
 *
 * Exported from the package root, unlike the conformance suite, because this IS the surface a consumer uses:
 * `apps/web/app/api/v1/payments/intent` calls `createPaymentIntent` and nothing else. It constructs no
 * adapter — every function takes a `PaymentGateway` the registry built — so
 * `payment-gateway-adapters-only-through-the-registry` is satisfied rather than exempted.
 */
export {
  applyGatewayEvents,
  type ClientCallbackClaim,
  type ClientCallbackOutcome,
  type ClientCallbackResult,
  type CreatePaymentIntentRequest,
  capturePaymentIntent,
  createPaymentIntent,
  type IntentOutcome,
  type MovePaymentIntentRequest,
  nextStateForStoredIntent,
  type PaymentIntentResult,
  type RefundPaymentIntentRequest,
  recordClientCallback,
  refundPaymentIntent,
  STORED_INITIAL_STATE,
  voidPaymentIntent,
} from './intent.ts'
/**
 * The mandate service (Y-PAY-07): where the pure fee gate and the append-only mandate rows meet.
 *
 * Exported from the root for `intent.ts`'s reason — it IS the surface a consumer uses, and it constructs
 * no adapter, so `payment-gateway-adapters-only-through-the-registry` is satisfied rather than exempted.
 * It reaches no gateway at all today: `PENDING['card-gateway']` means there is not one.
 */
export {
  activeMandateAmong,
  attemptFeeCharge,
  CHARGE_OUTCOMES,
  type ChargeOutcome,
  type FeeChargeAttempt,
  type MandateAgreement,
  type MandateDeps,
  mandateRecordFrom,
  outcomeForRefusal,
  recordMandateAgreement,
  revokeMandateAgreement,
  type StoredMandate,
} from './mandate.ts'
export { createRecordSink } from './record-sink.ts'
/**
 * The card-data detector, the refusal and the redactor (Y-PAY-03).
 *
 * The ONE implementation of the shape in this build; `scripts/check-saq-a.mjs` refuses a second Luhn check or
 * a second PAN pattern anywhere in the tree, because a second detector is a second policy and the second one
 * is the one that misses the spelling with spaces in it.
 */
export {
  assertNoCardData,
  CARD_DATA_FIELD_NAMES,
  CARD_DATA_REDACTED,
  CARD_SHAPE_PROBES,
  type CardDataFinding,
  CardDataRefused,
  cardDataFindings,
  cardShapedRuns,
  containsCardNumber,
  isLuhnValid,
  normaliseFieldName,
  PAN_MAX_DIGITS,
  PAN_MIN_DIGITS,
  redactCardData,
  redactedMessage,
  redactText,
  SECRET_FIELD_NAMES,
  SECRET_FIELD_REDACTED,
} from './redaction.ts'
export {
  createPaymentGateways,
  instrumentCoverage,
  NoGatewayServesInstrument,
  type PaymentGatewayRegistry,
  type PaymentGatewayRegistryOptions,
  resolveGateway,
} from './registry.ts'
export * from './webhook/handlers.ts'
export * from './webhook/verify.ts'
