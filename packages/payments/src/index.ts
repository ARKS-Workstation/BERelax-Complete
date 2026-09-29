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
export { createRecordSink } from './record-sink.ts'
export {
  createPaymentGateways,
  instrumentCoverage,
  NoGatewayServesInstrument,
  type PaymentGatewayRegistry,
  type PaymentGatewayRegistryOptions,
  resolveGateway,
} from './registry.ts'
