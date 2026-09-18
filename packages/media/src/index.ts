/**
 * @berelax/media — the derivative pipeline, immutable media URLs and the storage port.
 *
 * Importing this barrel pulls in `sharp`, and therefore libvips. Anything that runs in a browser — the
 * `next/image` loader above all — must import `@berelax/media/loader`, `/ladders` or `/url` instead,
 * which are the sharp-free halves.
 */
export {
  type BuildDerivativesInput,
  buildDerivatives,
  CENTRE_FOCAL,
  type DerivativeBuildResult,
  type DerivativeOutput,
  encodeRendition,
  type FocalPoint,
  isOriginalKey,
  type RenditionRequest,
  readSourceGeometry,
  type SourceGeometry,
  storeOriginal,
} from './derivatives.ts'
export { contentAddress, sha256Hex } from './hash.ts'
export {
  AVIF_OPTIONS,
  CONTENT_TYPES,
  CROP_NAMES,
  CROPS,
  type CropLadder,
  type CropName,
  type CropRect,
  cropRectFor,
  type DerivativeFormat,
  FORMATS,
  heightFor,
  isDeclaredWidth,
  JPEG_OPTIONS,
  nearestRung,
  type RenditionSpec,
  renditionSpecs,
  WEBP_OPTIONS,
} from './ladders.ts'
export {
  type ImageLoaderArgs,
  MAX_REQUESTED_WIDTH,
  mediaImageLoader,
  servedWidth,
} from './loader.ts'
export {
  isWithinPlaceholderBand,
  type Oklch,
  PLACEHOLDER_CHROMA_MAX,
  PLACEHOLDER_LIGHTNESS_MAX,
  PLACEHOLDER_LIGHTNESS_MIN,
  type Placeholder,
  placeholderCss,
  placeholderFor,
  type Rgb,
  rgbToOklch,
} from './placeholder.ts'
export {
  createFakeMediaStorage,
  DEFAULT_OUTBOX,
  type FakeStorageOptions,
  PUT_LOG,
} from './storage/fake.ts'
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
} from './storage/port.ts'
export {
  assertContentHash,
  assertCroppedSlot,
  assertMediaId,
  CONTENT_HASH_LENGTH,
  CONTENT_HASH_PATTERN,
  CROPPED_SLOTS,
  DERIVATIVE_PATH_PATTERN,
  type DerivativeRef,
  derivativePath,
  MEDIA_ID_PATTERN,
  MEDIA_SLOTS,
  type MediaSlotName,
  originalKey,
  PRIVATE_ORIGINALS_PREFIX,
  PUBLIC_DERIVATIVE_PREFIX,
  parseDerivativePath,
} from './url.ts'
