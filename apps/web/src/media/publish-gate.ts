import {
  assertLadderComplete,
  maxServedBytes,
  type ResolvedDerivativeSet,
  resolveDerivativeSet,
} from '@berelax/media/derivative-set'
import {
  mediaSlot,
  type PublicationRefusal,
  publicationRefusals,
  type SlotImageForPublication,
} from '@berelax/media/slots'
import { AppError } from '@berelax/shared'
import type { Payload } from 'payload'
import { appMediaStorage } from './storage.ts'

/**
 * The media half of a publish, in one place, read by both guards.
 *
 * W-SYS-10's acceptance says a bad publish is "blocked both in the UI and at the API endpoint (two
 * independent assertions, so the UI is never the only guard)". Independent is the point — two *assertions*,
 * not two implementations. Two implementations of a refusal drift, and the one that drifts is the one
 * nobody clicks. So both guards call this, and the test proves the API refuses a request the UI never sent.
 *
 * The rules themselves are W-SYS-09's `publicationRefusals`: `[media-slot-alt-fails-validation]` and
 * `[media-slot-over-byte-budget]`, each carrying the measured value. Nothing is re-decided here.
 *
 * ## What "publish" means in this unit, stated rather than implied
 *
 * There is no draft → lint → approved → published state machine yet: W-SITE-10 owns it and is `todo`. So
 * this endpoint is the media **gate** of a publish — it answers whether this image may reach the public,
 * and refuses with the measured weight when it may not. It does not itself put a page live, and it says so
 * in the response rather than returning a success that implies something was published. docs/12 §1: a stub
 * must never look like it worked.
 */

/**
 * Where the publish guard answers.
 *
 * Declared here rather than in the route, because the preview's `<form action>` and the route itself both
 * need it and a hand-typed copy in the form is the copy that stops matching the day the endpoint moves —
 * at which point the button posts to a 404 and the page reports nothing at all.
 */
export const PUBLISH_ENDPOINT = '/api/v1/media/publish'

/** The media row, narrowed to the fields a publication decision reads. */
export interface MediaPublishSubject {
  readonly mediaId: string
  readonly slot: string
  readonly alt: string | null
  readonly decorative: boolean
  readonly filename: string | null
  readonly context: readonly string[]
  readonly focalX: number
  readonly focalY: number
  readonly width: number
  readonly height: number
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

function altContextOf(document: Record<string, unknown>): readonly string[] {
  const raw = document['alt_context']
  if (!Array.isArray(raw)) return []
  return raw
    .map((row) =>
      row !== null && typeof row === 'object'
        ? asString((row as { readonly phrase?: unknown }).phrase)
        : undefined,
    )
    .filter((phrase): phrase is string => phrase !== undefined)
}

/**
 * The media row, read through Payload's access layer as the signed-in user.
 *
 * `overrideAccess: false` with the principal's id, not a bare read: a role that may not read media must not
 * be able to learn an image's alt text and byte weights by asking this endpoint for them. That is the same
 * rule the admin itself applies, applied by the same code.
 */
export async function loadMediaSubject(
  payload: Payload,
  mediaId: string,
  user: unknown,
): Promise<MediaPublishSubject | null> {
  const found = await payload.find({
    collection: 'media',
    where: { id: { equals: mediaId } },
    limit: 1,
    depth: 0,
    overrideAccess: false,
    // Payload types `user` as its own generated user; the row is the one this app's collection defines.
    user: user as never,
  })
  const document = found.docs[0] as Record<string, unknown> | undefined
  if (document === undefined) return null
  return {
    mediaId: String(document['id']),
    slot: asString(document['slot']) ?? '',
    alt: asString(document['alt']) ?? null,
    decorative: document['decorative'] === true,
    filename: asString(document['filename']) ?? null,
    context: altContextOf(document),
    // Payload defaults the focal point to the centre on every create, so these are never absent in
    // practice; the fallback is here because a row edited outside Payload can be.
    focalX: asNumber(document['focalX']) ?? 50,
    focalY: asNumber(document['focalY']) ?? 50,
    width: asNumber(document['width']) ?? 0,
    height: asNumber(document['height']) ?? 0,
  }
}

export interface MediaPublishAssessment {
  readonly subject: MediaPublishSubject
  readonly set: ResolvedDerivativeSet
  readonly refusals: readonly PublicationRefusal[]
}

/** The image as `publicationRefusals` takes it, with the measured weights attached. */
export function publicationSubject(
  subject: MediaPublishSubject,
  set: ResolvedDerivativeSet,
): SlotImageForPublication {
  const served = maxServedBytes(set)
  return {
    slot: subject.slot,
    alt: subject.alt,
    decorative: subject.decorative,
    filename: subject.filename ?? undefined,
    context: subject.context,
    ...(served === undefined ? {} : { servedBytes: served }),
  }
}

/**
 * Everything a publish decision needs: the row, the bucket, and the refusals.
 *
 * Throws `[derivative-ladder-incomplete]` when a rung is missing rather than deciding on a partial set. A
 * publish approved against three of eight rungs is a page with a hole in its `srcset`, which the browser
 * resolves by rendering nothing — on one screen size only, which is the hardest kind of failure to see.
 */
export async function assessMediaForPublication(
  payload: Payload,
  mediaId: string,
  user: unknown,
): Promise<MediaPublishAssessment | null> {
  const subject = await loadMediaSubject(payload, mediaId, user)
  if (subject === null) return null
  // Refuses an unknown or never-cropped slot by name before the bucket is touched.
  mediaSlot(subject.slot)
  const set = await resolveDerivativeSet(appMediaStorage(), mediaId, subject.slot)
  if (set === undefined) {
    throw new AppError(
      'not_found',
      `[media-original-absent] no original is stored for media ${mediaId}, so there is nothing to ` +
        'publish and no weight to measure.',
      { details: { mediaId } },
    )
  }
  assertLadderComplete(set)
  return { subject, set, refusals: publicationRefusals([publicationSubject(subject, set)]) }
}
