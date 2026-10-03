/**
 * The CDN purge port and its fake.
 *
 * A barrel of its own rather than an addition to `@berelax/media`'s: a purge is a statement about URLs and
 * the rest of this package is about bytes, and `packages/media/src/index.ts` is imported by the image
 * pipeline, which has no business reaching a CDN API.
 */
export {
  createFakePurge,
  FAKE_PURGE,
  type FakePurgeOptions,
  purgeIdempotencyKey,
} from './fake-purge.ts'
export type { PurgeOutboxEntry, PurgeOutcome, PurgePort, PurgeRequest } from './port.ts'
