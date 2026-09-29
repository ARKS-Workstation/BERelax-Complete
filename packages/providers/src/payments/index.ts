/**
 * The payment fakes' steering surface, reachable without the package barrel.
 *
 * `@berelax/providers` re-exports every port, which puts the SMS and email ports one hop from anything that
 * imports it — so `messaging-providers-only-inside-a-transport` bans the barrel outside a transport and tells
 * a consumer with a legitimate non-messaging need to import a subpath, as `packages/google` and
 * `packages/messaging` already do for `/google`, `/failure` and `/call-log`. This is that subpath for
 * `@berelax/payments`.
 *
 * What it exports is deliberately narrow: the REFERENCE MARKERS and nothing else. Y-PAY-01's card gateway
 * adapter implements the `@berelax/core` payment port rather than H02's `PaymentProvider`, and the one thing
 * it must not restate is the suffixes that steer a fake into its 3DS, declined and disputed paths — those
 * reach into seed data and fixtures, and a second spelling of `-3DS` would be a screenshot harness that
 * silently stopped exercising the challenge path.
 */

export { FAKE_GATEWAY, REFERENCE_MARKERS } from './fake-gateway.ts'
