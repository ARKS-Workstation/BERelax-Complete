import {
  assertAltAcceptable,
  assertUploadAllowed,
  isMediaSlotName,
  MEDIA_SLOT_LIST,
  MEDIA_SLOT_NAMES,
  mediaSlot,
  ORIGINAL_MIME_TYPES,
} from '@berelax/media/slots'
import { isAppError } from '@berelax/shared'
import type { CollectionConfig } from 'payload'
import { APIError } from 'payload'
import { collectionAccess } from '../payload/access.ts'
import { auditCollectionChange, auditCollectionDelete } from '../payload/audit.ts'

/**
 * The media row: a slot, alt text, a focal point, and the constraints all three are checked against.
 *
 * W-SYS-05 built the pipeline — the two art-directed ladders, the content-addressed immutable URLs, the
 * OKLCH placeholder, the storage port — and said in its manifest notes that "the media row itself — id,
 * slot, alt text, focal point, derivative manifest — belongs to W-SYS-09". This is that row.
 *
 * ## Why this is not generated from `@berelax/cms`'s descriptors
 *
 * The other seven collections are. This one cannot be, for two reasons that both matter.
 *
 * `CONTENT_FIELD_TYPES` has no numeric type, deliberately (see `@berelax/cms`'s `fields.ts`: every number
 * this business cares about is money, a duration or a count, and each has an owner that is not the CMS).
 * A focal point is two percentages, which is exactly the kind of number that list excludes — and rightly,
 * because it is not editorial content either. It is a property of a photograph.
 *
 * And it is an **upload** collection. Payload's `upload` block adds `filename`, `mimeType`, `filesize`,
 * `width`, `height`, `focalX` and `focalY` itself, from the file; a descriptor-driven `fields` list would
 * be declaring fields Payload already owns. So the shape here comes from Payload and the *constraints*
 * come from `@berelax/media/slots`, which is the single place a slot is declared.
 *
 * The catalogue boundary still applies and is still checked: `scripts/check-cms-boundary.mjs` scans this
 * directory, and the generated config it loads includes this collection's fields — Payload's own additions
 * among them.
 *
 * ## Why `disableLocalStorage`
 *
 * Payload's default is to write the file beside the app and serve it from a public route. An original must
 * never be publicly readable — docs/08 §6 puts originals in `berelax-private` with no CDN and no public
 * read, and nineteen of the twenty-five real assets are photographs of employees whose photography consent
 * is an open question (Y12-consent-photo). A public URL for those is not a performance problem, it is a
 * consent problem.
 *
 * So local storage is off and the row is metadata. What is deliberately *not* here is the put into the
 * private bucket and the `media.build-derivatives` enqueue: both need a storage adapter and a pg-boss
 * connection this app does not have (W-SYS-05's `[no-real-media-storage-adapter]` is the same gap seen
 * from the other side). That is recorded as a NOTE on W-SYS-09 in `build/manifest.yaml` rather than
 * papered over, because an upload surface that accepted bytes and dropped them while reporting success is
 * precisely the failure docs/12 §1 prohibits — and `derivative_manifest` below is empty until something
 * fills it, which is visible rather than assumed.
 */

/** What the hooks read off the document being saved. Payload types these as `unknown`-ish. */
interface MediaDocument {
  readonly slot?: unknown
  readonly alt?: unknown
  readonly decorative?: unknown
  readonly filename?: unknown
  readonly mimeType?: unknown
  readonly filesize?: unknown
  readonly width?: unknown
  readonly height?: unknown
  readonly focalX?: unknown
  readonly focalY?: unknown
  readonly alt_context?: unknown
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/**
 * Strings the alt text must add something to.
 *
 * Stored on the row rather than looked up, because the thing an alt string must not merely repeat is
 * whatever appears beside the image on the page — a treatment name, a heading, a quote — and this
 * collection has no way to know which page that is. An editor who pastes the heading in here is telling
 * the filter what to reject, which is the right way round: `alt_context` is small, optional, and the only
 * input the junk filter takes that is not measurable from the file.
 */
function altContext(document: MediaDocument): readonly string[] {
  const raw = document.alt_context
  if (!Array.isArray(raw)) return []
  return raw
    .map((row) =>
      row !== null && typeof row === 'object'
        ? asString((row as { readonly phrase?: unknown }).phrase)
        : undefined,
    )
    .filter((phrase): phrase is string => phrase !== undefined)
}

/** An `AppError` refusal becomes the 400 the admin shows against the field; anything else is a bug. */
function refuse(error: unknown, field: string): never {
  if (!isAppError(error)) throw error
  throw new APIError(error.message, 400, { field, ...error.details }, true)
}

/**
 * The server-side gate.
 *
 * `beforeChange`, not `validate` on each field. Three of the constraints — the ratio, the minimum
 * dimensions, the byte cap — are relationships between the slot and the *file*, and a field validator sees
 * one value: `alt` cannot know which slot it is in, and `slot` cannot know how big the file is. A
 * per-field validator would therefore have to reach into sibling data, which Payload offers and which
 * silently receives `undefined` on a partial update.
 *
 * It also runs on every save, not only on create. A row can be edited after it was accepted — the slot
 * changed, the alt text emptied — and a check that only ran at upload would be a check the second save
 * walks past.
 */
function assertMediaRowAcceptable(document: MediaDocument): void {
  const slotName = asString(document.slot)
  if (slotName === undefined || !isMediaSlotName(slotName)) {
    throw new APIError(
      `[unknown-slot] '${String(document.slot)}' is not a declared media slot. The slots are ` +
        `${MEDIA_SLOT_NAMES.join(', ')} — see packages/media/src/slots/registry.ts.`,
      400,
      { field: 'slot' },
      true,
    )
  }
  const slot = mediaSlot(slotName)

  const width = asNumber(document.width)
  const height = asNumber(document.height)
  const filesize = asNumber(document.filesize)
  const mimeType = asString(document.mimeType)
  const focalX = asNumber(document.focalX)
  const focalY = asNumber(document.focalY)

  // A file whose dimensions Payload could not read is not a file this pipeline can crop. Refusing is the
  // only honest answer: accepting it would mean a row whose constraints were never checked, and the
  // derivative job would fail later with `[unreadable-original]` where nobody is watching.
  if (width === undefined || height === undefined || filesize === undefined) {
    throw new APIError(
      '[unmeasured-original] this upload has no readable dimensions or size, so none of the slot ' +
        'constraints could be checked. Re-export it as a JPEG or PNG and upload again.',
      400,
      { field: 'file' },
      true,
    )
  }

  try {
    assertUploadAllowed({
      slot: slotName,
      mimeType: mimeType ?? 'application/octet-stream',
      byteLength: filesize,
      width,
      height,
      ...(focalX === undefined || focalY === undefined ? {} : { focal: { x: focalX, y: focalY } }),
      filename: asString(document.filename),
    })
  } catch (error) {
    refuse(error, 'file')
  }

  try {
    assertAltAcceptable({
      slot,
      alt: asString(document.alt) ?? null,
      decorative: document.decorative === true,
      filename: asString(document.filename),
      context: altContext(document),
    })
  } catch (error) {
    refuse(error, 'alt')
  }
}

export const MEDIA: CollectionConfig = {
  slug: 'media',
  labels: { singular: 'Image', plural: 'Images' },
  admin: {
    useAsTitle: 'alt',
    description:
      'Photographs, by slot. Every slot declares its ratio, minimum size, byte cap and accepted ' +
      'formats in packages/media/src/slots/registry.ts, and alt text is required and filtered.',
    defaultColumns: ['alt', 'slot', 'filename', 'updatedAt'],
  },
  upload: {
    // See the file header. An original is never publicly readable.
    disableLocalStorage: true,
    // The file picker offers only what a slot can accept. It is a convenience, not the check — a picker
    // filter is client-side and the constraint is enforced in `beforeChange` for every slot.
    mimeTypes: [...ORIGINAL_MIME_TYPES],
    // docs/08 §6 asks for Payload's native focal point, stored as percentages, with the crop applied
    // before the resize. `focalX`/`focalY` are percentages in Payload and `cropRectFor` in
    // `@berelax/media` takes them as such, which is what keeps one focal point correct at every rung.
    focalPoint: true,
    // Payload's own crop tool is off. Two crops are taken from every original — 4:5 for phones and 16:9
    // above them — and an editor-chosen rectangle can only be one of them, so offering it would mean a
    // hand-cropped source that the job then crops again.
    crop: false,
  },
  access: {
    read: collectionAccess('read'),
    create: collectionAccess('create'),
    update: collectionAccess('update'),
    delete: collectionAccess('delete'),
  },
  hooks: {
    beforeChange: [
      ({ data, originalDoc }) => {
        // Merged with the stored document, because Payload sends only the changed fields on an update and
        // a partial payload would arrive here with `slot` or `width` missing — which would read as an
        // unmeasured file on every edit of an accepted row.
        assertMediaRowAcceptable({
          ...(originalDoc as MediaDocument | undefined),
          ...(data as MediaDocument),
        })
        return data
      },
    ],
    afterChange: [auditCollectionChange],
    afterDelete: [auditCollectionDelete],
  },
  fields: [
    {
      name: 'slot',
      type: 'select',
      label: 'Slot',
      required: true,
      // Spread from the registry, not retyped. A slot name the registry does not know would be a row the
      // derivative URL builder refuses with `[unknown-slot]` at build time and nowhere earlier.
      options: MEDIA_SLOT_LIST.map((slot) => ({ label: slot.label, value: slot.name })),
      admin: {
        description:
          'Which slot this image is for. The slot decides the ratio, the minimum size and the byte cap.',
      },
    },
    {
      name: 'alt',
      type: 'text',
      label: 'Alt text',
      // Not `required: true`. Payload's required check would refuse a decorative image before the filter
      // could decide whether empty is the correct answer for its slot, and the message it produces ("This
      // field is required") says nothing about what to write. The requirement is enforced in
      // `beforeChange` by the filter, which knows the difference between empty-by-decision and
      // empty-by-omission.
      admin: {
        description:
          'What the image shows, for a reader who cannot see it. At least 15 characters. “image”, ' +
          '“photo”, a filename or the heading repeated are rejected — they pass a required field and ' +
          'fail a screen reader, and alt text is indexed.',
      },
    },
    {
      name: 'decorative',
      type: 'checkbox',
      label: 'Decorative (announces nothing)',
      admin: {
        description:
          'Only for a testimonial background. WCAG 1.1.1: a decorative image takes empty alt text — ' +
          'but saying so is a decision, and every other slot holds images that are content.',
      },
    },
    {
      name: 'alt_context',
      type: 'array',
      label: 'Words already beside this image',
      admin: {
        description:
          'Optional. The heading, treatment name or quote this image sits next to. Alt text that is ' +
          'just one of these repeated is rejected: it gives a screen-reader user the same words twice.',
      },
      fields: [{ name: 'phrase', type: 'text', label: 'Phrase', required: true }],
    },
    {
      name: 'credit',
      type: 'text',
      label: 'Photographer credit',
      admin: {
        description:
          'Optional, and not a licence record. docs/08 §6 makes model releases and staff photography ' +
          'consent a requirement; those live with the person, not here.',
      },
    },
    {
      name: 'derivative_manifest',
      type: 'json',
      label: 'Derivatives',
      admin: {
        readOnly: true,
        description:
          'Written by the media.build-derivatives job. Empty means no derivative exists yet, which is ' +
          'why it is readable: a row that looked complete without one would be an image nothing can serve.',
      },
    },
  ],
}
