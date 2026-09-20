import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { contentAddress } from '@berelax/media/hash'
import type { DerivativeSetRef } from '@berelax/media/srcset'
import { AppError } from '@berelax/shared'

/**
 * The media references the hero demo route renders, and the two different honesties they need.
 *
 * ## The poster is real
 *
 * `assets/media/photos/hero-team.jpg` is a committed photograph of the business's own premises, in the
 * `hero` slot, with a declared focal point. Its content address is the first sixteen hex of the sha256 of
 * **its own bytes** — the same function the derivative job addresses its output with — so the URLs this
 * route renders are the URLs the pipeline produces for that file, byte for byte, and the derivative origin
 * serves them the moment the job has run.
 *
 * ## The video master does not exist, and this says so rather than looking as if it does
 *
 * There is **no hero footage** (`Y12-hero-video`): twenty-five committed files and not one frame of video.
 * W-SYS-06 encodes from a deliberately marked stand-in whose y4m header names the open question, and
 * nothing has uploaded a master to any bucket. So there is no master whose bytes can be hashed, and
 * inventing a plausible sixteen-hex address would produce exactly what
 * `docs/CONTRIBUTING-AGENT-BRIEF.md` §15 forbids: a value indistinguishable from a configured one.
 *
 * What this returns instead is a **derived and marked** identity. Both fields are computed from the
 * photograph's own address under a domain separator that contains the open-question id, so:
 *
 *  - it is reproducible and carries no new information — nothing here was chosen;
 *  - it cannot collide with a real master's address, because a real one is the digest of video bytes;
 *  - `STAND_IN_NOTE` travels with it and the route prints it, so the page states in prose that these four
 *    URLs are what the pipeline *will* serve and that nothing answers them yet.
 *
 * The consequence on the page is visible rather than hidden: the island attaches the sources, the requests
 * 404, the element cannot play, and the still remains — which is the same path a deploy with an unbuilt
 * rendition takes, and is worth being able to look at.
 */

/** Where the poster comes from. One slot, one file: the hero. */
export const HERO_DEMO_ASSET = 'photos/hero-team.jpg'

/** The open question the video half of this route is blocked on. */
export const HERO_VIDEO_OPEN_QUESTION = 'Y12-hero-video'

/** What the route says about the video, in one sentence it must not be able to drop silently. */
export const STAND_IN_NOTE =
  'There is no hero footage yet (Y12-hero-video), so no video master has been uploaded and no rendition ' +
  'has been encoded. The four source URLs below are the paths the pipeline will produce, derived from the ' +
  'poster so that nothing here is a plausible-looking address for a file that does not exist; they answer ' +
  '404 today, and the island therefore attaches them, fails, and leaves the still — which is exactly what ' +
  'a deploy with an unbuilt rendition does.'

const MEDIA_LIBRARY_MARKER = join('assets', 'media', 'manifest.json')

/**
 * Walks up from the working directory to the media library.
 *
 * The same resolution `app/(en)/(dev)/kitchen-sink/portraits.ts` and `src/media/storage.ts` use, and for
 * the reason the first of those records: bundled into a server chunk, `import.meta.dirname` is the chunk's
 * directory, so a loader anchored on it looks for the photographs inside `.next/server`.
 */
function mediaRoot(): string {
  let directory = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(directory, MEDIA_LIBRARY_MARKER))) return join(directory, 'assets', 'media')
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new AppError(
    'invariant_violated',
    `[media-library-not-found] no ${MEDIA_LIBRARY_MARKER} above ${process.cwd()}; the hero demo route ` +
      'renders the committed photograph and has nothing to render without it.',
  )
}

/** A uuid derived from a string. Deterministic, and never a row id anything else will hand out. */
function derivedUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

export interface HeroDemoMedia {
  /** The poster: a real file, a real content address. */
  readonly poster: DerivativeSetRef
  /** The video: derived, marked, and answering 404 until a master is uploaded and the job has run. */
  readonly video: { readonly mediaId: string; readonly contentHash: string }
  /** The poster's declared focal point, so the test can build the same crop the page renders. */
  readonly focal: { readonly x: number; readonly y: number }
  readonly note: string
}

interface ManifestAsset {
  readonly path: string
  readonly slot: string
  readonly focalX?: number
  readonly focalY?: number
}

let cached: HeroDemoMedia | undefined

/**
 * The demo's two references, computed once per process.
 *
 * Cached because the poster's address is a sha256 of 232KB and this is a route that renders on every
 * request; not cached across processes, because the whole point of a content address is that it changes
 * when the file does.
 */
export function heroDemoMedia(): HeroDemoMedia {
  if (cached !== undefined) return cached
  const root = mediaRoot()
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
    readonly assets: readonly ManifestAsset[]
  }
  const asset = manifest.assets.find((candidate) => candidate.path === HERO_DEMO_ASSET)
  if (asset === undefined) {
    throw new AppError(
      'invariant_violated',
      `[hero-demo-asset-missing] ${HERO_DEMO_ASSET} is not in assets/media/manifest.json`,
    )
  }
  // `turbopackIgnore` for the reason portraits.ts gives: the bundler cannot see where this path goes, and
  // its fallback is to trace the whole repository into the server output.
  const bytes = readFileSync(join(/* turbopackIgnore: true */ root, asset.path))
  const posterHash = contentAddress(bytes)
  cached = {
    poster: {
      mediaId: derivedUuid(`hero-demo-poster:${asset.path}`),
      contentHash: posterHash,
      slot: asset.slot,
    },
    video: {
      mediaId: derivedUuid(`hero-demo-video:${HERO_VIDEO_OPEN_QUESTION}`),
      // Not the digest of any video bytes, because there are none. Derived from the poster's address under
      // a separator naming the open question, so it is reproducible, carries no invented information, and
      // cannot be mistaken for the address of a master somebody delivered.
      contentHash: contentAddress(Buffer.from(`${HERO_VIDEO_OPEN_QUESTION}:${posterHash}`, 'utf8')),
    },
    focal: { x: asset.focalX ?? 50, y: asset.focalY ?? 50 },
    note: STAND_IN_NOTE,
  }
  return cached
}
