/**
 * The real photographs, for the kitchen sink.
 *
 * `assets/media/` holds nineteen staff portraits taken from the business's own prototype site. They are
 * used here rather than placeholders because the thing this page has to prove is that a card crops a
 * *real* portrait correctly: the natives run from 0.461 to 0.799 and the face sits in roughly the top
 * fifth of the frame, so a 4:5 centre crop produces a torso. A grey rectangle proves nothing about that,
 * and it is the defect a placeholder hides.
 *
 * ## Why this does not use `@berelax/fixtures`
 *
 * `packages/fixtures/src/media.ts` is the canonical loader and resolves the media root from
 * `import.meta.dirname`. Bundled into a server chunk by Turbopack that directory is the chunk's, not the
 * package's, so the loader would look for the photographs inside `.next/server`. Anchoring on
 * `process.cwd()` and walking up to the manifest is the resolution that survives bundling. The fixtures
 * package is also a test dependency, and this is an application route.
 *
 * Nothing here invents a name: the manifest has none, because the site has none, and a therapist has no
 * display name until an admin sets one with a recorded consent (ADR 0020).
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

interface ManifestAsset {
  readonly path: string
  readonly slot: string
  readonly focalX?: number
  readonly focalY?: number
}

interface Manifest {
  readonly assets: readonly ManifestAsset[]
}

export interface Portrait {
  /** Index into the portrait list, which is also its URL under this route. */
  readonly index: number
  /** `object-position`, so the crop keeps the face in frame. */
  readonly objectPosition: string
}

/** Walks up from the working directory to the repository's media library. */
function mediaRoot(): string {
  let directory = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, 'assets', 'media')
    if (existsSync(join(candidate, 'manifest.json'))) return candidate
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new Error('assets/media/manifest.json not found above the working directory')
}

let cached: readonly ManifestAsset[] | undefined

function portraitAssets(): readonly ManifestAsset[] {
  if (cached === undefined) {
    const manifest = JSON.parse(
      readFileSync(join(mediaRoot(), 'manifest.json'), 'utf8'),
    ) as Manifest
    cached = manifest.assets.filter((asset) => asset.slot === 'therapist-portrait')
  }
  return cached
}

/** The first `count` portraits, with the focal point each one declares. */
export function portraits(count: number): Portrait[] {
  return portraitAssets()
    .slice(0, count)
    .map((asset, index) => ({
      index,
      objectPosition: `${asset.focalX ?? 50}% ${asset.focalY ?? 50}%`,
    }))
}

/** One portrait's bytes, for the route handler that serves them. */
export function portraitBytes(index: number): { bytes: Buffer; contentType: string } | undefined {
  const asset = portraitAssets()[index]
  if (asset === undefined) return undefined
  return {
    // `turbopackIgnore` because the bundler's static analysis cannot see where this path goes, and its
    // fallback is to trace the *whole repository* into the server output — every source file and every
    // asset, on a route that serves three photographs on a development page.
    bytes: readFileSync(join(/* turbopackIgnore: true */ mediaRoot(), asset.path)),
    contentType: asset.path.endsWith('.png') ? 'image/png' : 'image/jpeg',
  }
}
