/**
 * What is actually in the bucket for one media id — real paths, real byte counts.
 *
 * The breakpoint preview reports "per-rung transferred bytes", and the only honest source for that number
 * is the object a browser would download. An estimate computed from the source's pixel count and a
 * quality setting would be a number that tracks nothing: AVIF spends bytes on *detail*, so two 2560-wide
 * photographs of the same scene differ by a factor of three, and a budget checked against an estimate
 * passes while the file is over. So this reads the bucket.
 *
 * ## Why the current content address comes from the original
 *
 * A derivative path carries the sha256 of the source bytes, which is what makes a year of `immutable`
 * safe — and it means that replacing an original leaves the *old* derivatives in the bucket, at their own
 * paths, forever. Listing `m/{mediaId}/` therefore finds every generation of the image, and picking one
 * by sorting would show the editor whichever crop happened to sort first.
 *
 * The original is the answer: there is exactly one object at the original's key, replacing it overwrites
 * it, and `contentAddress` of those bytes is by definition the prefix of the paths that are current. That
 * is also production's own rule rather than a convenience for the preview — the job addresses the
 * derivatives it writes the same way.
 *
 * ## Why a missing ladder is a state and not an error
 *
 * `derivative_manifest` on a media row is empty until `media.build-derivatives` fills it, and the job is
 * enqueued by an upload path that is not wired yet (see the NOTE on W-SYS-09). A row with no derivatives
 * is therefore a normal, visible condition — so this returns `outputs: []` and the preview renders "not
 * built yet" rather than throwing a 500 that reads like a broken page. What it must never do is invent a
 * path: an `<img>` pointing at an object nobody built is a 404 the browser resolves by showing nothing.
 */
import { AppError } from '@berelax/shared'
import { contentAddress } from './hash.ts'
import {
  CROP_NAMES,
  CROPS,
  type CropName,
  type DerivativeFormat,
  FORMATS,
  heightFor,
} from './ladders.ts'
import { type MediaStorage, publicKeyFor } from './storage/port.ts'
import {
  assertCroppedSlot,
  assertMediaId,
  derivativePath,
  type MediaSlotName,
  originalKey,
} from './url.ts'

/** The accepted original extensions, in the order they are probed. Mirrors `ORIGINAL_MIME_TYPES`. */
export const ORIGINAL_EXTENSIONS: readonly string[] = ['jpg', 'jpeg', 'png']

export interface DerivativeRendition {
  readonly path: string
  readonly crop: CropName
  readonly width: number
  readonly height: number
  readonly format: DerivativeFormat
  /** The object's size in the bucket, as `head` reports it. Never computed. */
  readonly bytes: number
}

export interface ResolvedDerivativeSet {
  readonly mediaId: string
  readonly slot: MediaSlotName
  /** First sixteen hex of the sha256 of the **current** original. */
  readonly contentHash: string
  /** The private-bucket key the address was taken from, so a report can name it. */
  readonly sourceKey: string
  readonly sourceBytes: number
  /** Every rung present in the bucket at this content address, ladder order. */
  readonly outputs: readonly DerivativeRendition[]
  /** Rungs the ladders declare and the bucket does not hold. Empty when the build is complete. */
  readonly missing: readonly string[]
}

/** The original for a media id, or undefined when nothing has been uploaded for it. */
async function findOriginal(
  storage: MediaStorage,
  mediaId: string,
): Promise<{ readonly key: string; readonly bytes: Uint8Array } | undefined> {
  for (const extension of ORIGINAL_EXTENSIONS) {
    const key = originalKey(mediaId, extension)
    const head = await storage.head({ bucket: 'private', key })
    if (head === undefined) continue
    return { key, bytes: await storage.get({ bucket: 'private', key }) }
  }
  return undefined
}

/**
 * The derivative set for one media id in one slot, read out of the bucket.
 *
 * `slot` is a parameter rather than something inferred from the object keys, and that is deliberate: the
 * slot is a property of the row an editor set, and inferring it from whatever happens to be in the bucket
 * would make a stale ladder from a previous slot look like the current one.
 */
export async function resolveDerivativeSet(
  storage: MediaStorage,
  mediaId: string,
  slot: string,
): Promise<ResolvedDerivativeSet | undefined> {
  assertMediaId(mediaId)
  const named = assertCroppedSlot(slot)
  const original = await findOriginal(storage, mediaId)
  if (original === undefined) return undefined

  const contentHash = contentAddress(original.bytes)
  const outputs: DerivativeRendition[] = []
  const missing: string[] = []

  for (const crop of CROP_NAMES) {
    for (const width of CROPS[crop].widths) {
      for (const format of FORMATS) {
        const path = derivativePath({ mediaId, contentHash, slot: named, crop, width, format })
        const head = await storage.head({ bucket: 'public', key: publicKeyFor(path) })
        if (head === undefined) {
          missing.push(path)
          continue
        }
        outputs.push({
          path,
          crop,
          width,
          height: heightFor(crop, width),
          format,
          bytes: head.bytes,
        })
      }
    }
  }

  return {
    mediaId,
    slot: named,
    contentHash,
    sourceKey: original.key,
    sourceBytes: original.bytes.length,
    outputs,
    missing,
  }
}

/** The bytes of one rung in one format, or undefined when that rung was never built. */
export function bytesOfRung(
  set: ResolvedDerivativeSet,
  crop: CropName,
  width: number,
  format: DerivativeFormat,
): number | undefined {
  return set.outputs.find(
    (output) => output.crop === crop && output.width === width && output.format === format,
  )?.bytes
}

/**
 * The heaviest rung per crop, in the format a modern browser is actually served.
 *
 * **The maximum, not the widest.** In practice they are the same object — bytes rise with pixels — and
 * defining it as the maximum is what makes "any rung over the slot budget" and "the served weight is over
 * the slot budget" the same sentence. Feeding `publicationRefusals` the widest instead would leave a
 * refusal that the preview showed and the API did not, for a source whose compression is not monotonic in
 * width (a fine texture can cost more at 1440 than at 1920 once the resampler has smoothed it).
 *
 * AVIF, because that is the first `<source>` and every browser this project targets decodes it. The WebP
 * and JPEG rungs exist for the ones that do not, and measuring a JPEG fallback against docs/08 §8's figure
 * would be comparing it with a budget written for the AVIF poster.
 */
export function maxServedBytes(
  set: ResolvedDerivativeSet,
): { readonly mobile: number; readonly desktop: number } | undefined {
  const heaviest = (crop: CropName): number | undefined => {
    const bytes = set.outputs
      .filter((output) => output.crop === crop && output.format === 'avif')
      .map((output) => output.bytes)
    return bytes.length === 0 ? undefined : Math.max(...bytes)
  }
  const mobile = heaviest('mobile')
  const desktop = heaviest('desktop')
  if (mobile === undefined || desktop === undefined) return undefined
  return { mobile, desktop }
}

export interface RungVerdict {
  readonly rendition: DerivativeRendition
  /** The slot's budget for this rung's crop, or null when docs/08 states none for the slot. */
  readonly budgetBytes: number | null
  readonly overBudget: boolean
}

/**
 * Every rung of one format measured against its crop's budget.
 *
 * Every rung, not only the widest. The acceptance criterion is "any rung over the slot budget", and the
 * strict reading is the right one: a budget is a cap on what may be downloaded, and a browser that picks
 * the 828 rung downloads the 828 rung. In practice the widest is the binding one, which is a property of
 * the ladder rather than something to assume here.
 *
 * `null` budget means docs/08 §8 states none for the slot — the hero is the only slot with a figure — and
 * a null budget is never over. Inventing a per-slot number so that every slot had one would put a figure
 * nobody derived into an editor's refusal message.
 */
export function rungVerdicts(
  set: ResolvedDerivativeSet,
  budget: { readonly mobile: number; readonly desktop: number } | null,
  format: DerivativeFormat = 'avif',
): readonly RungVerdict[] {
  return set.outputs
    .filter((rendition) => rendition.format === format)
    .map((rendition) => {
      const budgetBytes = budget === null ? null : budget[rendition.crop]
      return {
        rendition,
        budgetBytes,
        overBudget: budgetBytes !== null && rendition.bytes > budgetBytes,
      }
    })
}

/** Refuses a set whose ladder is incomplete, naming the first path that is absent. */
export function assertLadderComplete(set: ResolvedDerivativeSet): void {
  if (set.missing.length === 0) return
  throw new AppError(
    'not_found',
    `[derivative-ladder-incomplete] ${set.missing.length} of the ladder's renditions are not in the ` +
      `bucket for media ${set.mediaId}, starting with ${set.missing[0]}. A rung missing from a srcset ` +
      'is a 404 the browser resolves by rendering nothing, on one screen size only.',
    { details: { mediaId: set.mediaId, missing: set.missing.length, first: set.missing[0] } },
  )
}
