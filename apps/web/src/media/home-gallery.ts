import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { contentAddress } from '@berelax/media/hash'
import type { DerivativeSetRef } from '@berelax/media/srcset'
import { AppError } from '@berelax/shared'
import { repositoryRoot } from './storage.ts'

/**
 * The home page's gallery: the committed interiors, addressed by their own bytes.
 *
 * ## Why these three files and not a media collection
 *
 * `assets/media/` holds twenty-five files extracted from the business's own prototype
 * (`assets/media/README.md`), and four of them are photographs of the premises: `hero-team.jpg`, which is
 * the hero, and `spa-01`…`spa-03`, which are the interiors. There is no Payload media row for any of them —
 * nothing has uploaded one — so a gallery driven by a collection would render nothing at all, on a page
 * whose whole subject is a place. These are real files of the real premises, so they are what the gallery
 * renders, and their URLs are computed the way the pipeline computes them rather than written down.
 *
 * `contentAddress` is the function the derivative job addresses its output with, so the paths
 * `SlotPicture` renders here are byte-for-byte the paths `buildDerivatives` produces for these files. The
 * consequence is visible and is the same one `hero-demo-asset.ts` records for the hero: until the job has
 * run, those URLs answer 404 and the page shows the reserved box in the slot's placeholder colour. That is
 * what `SlotPicture` reserves the box *for* — the photograph arrives later with no layout shift — and it is
 * strictly better than the alternatives, which are a hand-written URL that can never be right or a gallery
 * that renders nothing and says the interiors do not exist.
 *
 * ## Why the media id is derived rather than invented
 *
 * A `mediaId` is a row id in a collection that has no rows. Brief rule 15 forbids a plausible value for
 * something the real system will one day hold — a random uuid here would be indistinguishable from a real
 * media row's id — so it is a **function of the file's own path**, under a separator naming this module. It
 * is reproducible, it carries no information nobody supplied, and it cannot collide with a `uuid_generate_v7`
 * a collection hands out, because it is not time-ordered. The same device, for the same reason, as
 * `derivedUuid` in `src/media/hero-demo-asset.ts`.
 */

/** The interiors, in the order the prototype shows them. */
export const GALLERY_ASSETS = [
  'photos/spa-01.jpg',
  'photos/spa-02.jpg',
  'photos/spa-03.jpg',
] as const

interface ManifestAsset {
  readonly path: string
  readonly slot: string
  readonly focalX?: number
  readonly focalY?: number
}

/**
 * A uuid derived from a string, by the same construction `hero-demo-asset.ts` uses.
 *
 * Duplicated rather than shared, and the duplication is the lesser evil: the alternative is for this module
 * to import a private helper out of the module that exists to describe *one development route's* media, or
 * for that module to grow an export it has no use for. Both make one unit's file the home of another's
 * concept. What must not be duplicated is the **content address**, and it is not: `contentAddress` is
 * imported from `@berelax/media/hash`, which is the one answer to "what is this file's address".
 */
function derivedUuid(seed: string): string {
  const hex = contentAddress(Buffer.from(seed, 'utf8'))
  // `contentAddress` returns the first sixteen hex of a sha256 — 16 characters, and a uuid needs 32. The
  // second half is the address of the address, which keeps the whole value a function of the seed alone.
  const full = `${hex}${contentAddress(Buffer.from(hex, 'utf8'))}`
  return [
    full.slice(0, 8),
    full.slice(8, 12),
    full.slice(12, 16),
    full.slice(16, 20),
    full.slice(20, 32),
  ].join('-')
}

export interface GalleryImage {
  readonly media: DerivativeSetRef
  /** The file it came from, so a failure names something a person can open. */
  readonly source: string
}

let cached: readonly GalleryImage[] | undefined

/**
 * The three interiors, computed once per process.
 *
 * Cached because this is read on every render of an ISR page and each entry is a sha256 of about 200KB;
 * not cached across processes, because a content address that survived the file changing would be the one
 * thing a content address exists to prevent.
 */
export function homeGalleryImages(): readonly GalleryImage[] {
  if (cached !== undefined) return cached
  const root = join(repositoryRoot(), 'assets', 'media')
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8')) as {
    readonly assets: readonly ManifestAsset[]
  }
  cached = GALLERY_ASSETS.map((path) => {
    const asset = manifest.assets.find((candidate) => candidate.path === path)
    if (asset === undefined) {
      throw new AppError(
        'invariant_violated',
        `[home-gallery-asset-missing] ${path} is not in assets/media/manifest.json, so the home page's ` +
          'gallery has nothing to render for it. `pnpm media:emit` rebuilds the manifest from the files.',
      )
    }
    // `turbopackIgnore` for the reason `kitchen-sink/portraits.ts` gives: the bundler cannot see where a
    // computed path goes, and its fallback is to trace the whole repository into the server output.
    const bytes = readFileSync(join(/* turbopackIgnore: true */ root, asset.path))
    return {
      media: {
        mediaId: derivedUuid(`home-gallery:${asset.path}`),
        contentHash: contentAddress(bytes),
        slot: asset.slot,
      },
      source: path,
    }
  })
  return cached
}
