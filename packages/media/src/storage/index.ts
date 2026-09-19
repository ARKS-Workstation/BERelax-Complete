/**
 * The storage port and the fake adapter, without the encoder.
 *
 * A subpath of its own because `apps/web` needs a bucket in a route handler — the derivative origin and
 * the breakpoint preview both read objects — and importing the package barrel there would pull `sharp`,
 * and therefore libvips, into a Next server chunk that never encodes anything.
 */
export {
  createFakeMediaStorage,
  DEFAULT_OUTBOX,
  type FakeStorageOptions,
  PUT_LOG,
} from './fake.ts'
export {
  derivativeHeaders,
  IMMUTABLE_CACHE_CONTROL,
  MEDIA_BUCKETS,
  type MediaBucket,
  type MediaStorage,
  PRIVATE_CACHE_CONTROL,
  type PutRequest,
  publicKeyFor,
  type ServedHeaders,
  type StoredObject,
} from './port.ts'
