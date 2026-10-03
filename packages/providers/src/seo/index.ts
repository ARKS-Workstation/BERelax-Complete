/**
 * The IndexNow port and its fake, on a subpath of their own.
 *
 * A subpath rather than the package barrel, and the reason is a boundary rule rather than taste:
 * `.dependency-cruiser.cjs`'s `messaging-providers-only-inside-a-transport` bans `@berelax/providers`'
 * **barrel** outside a messaging transport, because the barrel re-exports the SMS and email ports — so
 * `import { anything } from '@berelax/providers'` reaches SMSala while naming nothing forbidden. A
 * consumer with a legitimate non-messaging need imports a subpath, which is what `packages/google` does
 * and what `apps/worker`'s propagation job does here.
 */
export {
  createFakeIndexNow,
  FAKE_INDEXNOW,
  type FakeIndexNowOptions,
  INDEXNOW_KEY_UNSET,
  indexNowIdempotencyKey,
  indexNowKeyIsUnset,
} from './fake-indexnow.ts'
export {
  INDEXNOW_ENDPOINT,
  INDEXNOW_MAX_URLS,
  type IndexNowOutboxEntry,
  type IndexNowOutcome,
  type IndexNowProvider,
  type IndexNowRejection,
  type IndexNowSubmission,
} from './port.ts'
