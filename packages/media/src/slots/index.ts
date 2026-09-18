/**
 * `@berelax/media/slots` — the slot registry, the upload validator and the junk-alt filter.
 *
 * A separate entry point from the package barrel for the same reason `/ladders`, `/loader` and `/url` are:
 * importing `@berelax/media` pulls in `sharp` and therefore libvips. Nothing here touches a file or an
 * image, so a browser bundle and `packages/ui` can read a slot's aspect ratio without any of that.
 */
export {
  ALT_MIN_LENGTH,
  ALT_MIN_LETTERS,
  ALT_VIOLATION_RULES,
  type AltSubject,
  type AltViolation,
  type AltViolationRule,
  altViolations,
  assertAltAcceptable,
  isJunkAlt,
} from './alt-filter.ts'
export {
  CROPPED_SLOT_NAMES,
  EDITABLE_SLOT_NAMES,
  isMediaSlotName,
  MEDIA_SLOT_LIST,
  MEDIA_SLOT_NAMES,
  type MediaSlot,
  type MediaSlotName,
  mediaSlot,
  ORIGINAL_MIME_TYPES,
  type OriginalMimeType,
  type ProvisionalPlaceholder,
  provisionalSlotPlaceholders,
  SLOT_RATIO_TOLERANCE,
  SLOT_REGISTRY,
  type SlotPlaceholder,
  slotAspectRatio,
  slotPlaceholderColour,
  slotRatio,
} from './registry.ts'
export {
  assertSlotImagesPublishable,
  assertUploadAllowed,
  declaredCropRect,
  type FocalPercent,
  PUBLICATION_REFUSAL_RULES,
  type PublicationRefusal,
  type PublicationRefusalRule,
  publicationRefusals,
  ratioDeviation,
  SLOT_VIOLATION_RULES,
  type SlotImageForPublication,
  type SlotViolation,
  type SlotViolationRule,
  type UploadMeasurement,
  validateUpload,
} from './validate.ts'
