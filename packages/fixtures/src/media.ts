/**
 * The media library, read from `assets/media/manifest.json`.
 *
 * Real photographs from the business's own prototype site — nineteen staff portraits, four interiors,
 * two logos. Not stock, not generated, and not of anybody who does not work there.
 *
 * Two facts about this library shape the code that uses it.
 *
 * **The portraits have no names attached, because the site has none.** That is not an omission to fill
 * in: it is the launch state, and ADR 0020 turns it into a rule — a therapist page publishes only with
 * a display name and a recorded photography consent. The build does not invent names.
 *
 * **Their native aspect ratios run from 0.461 to 0.799**, and they are full-length shots with the face
 * in roughly the top fifth of the frame. A grid at a fixed 4:5 with a centre crop produces a row of
 * torsos, so every portrait carries a focal point and the renderer uses it. The focal points in the
 * manifest are a defensible default from the framing, not a per-face measurement; doing that properly
 * is the `Y12-photos` media audit.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError } from '@berelax/shared'

export type MediaSlot = 'therapist-portrait' | 'hero' | 'logo'

export interface MediaAsset {
  /** Path relative to `assets/media/`. */
  readonly path: string
  readonly slot: MediaSlot
  readonly width: number
  readonly height: number
  readonly bytes: number
  /** Percentages. Absent only for a slot that does not crop. */
  readonly focalX?: number
  readonly focalY?: number
}

export interface SlotSpec {
  /** Target ratio as [w, h], or null for a slot that is never cropped. */
  readonly ratio: readonly [number, number] | null
  readonly minWidth: number
  readonly focalRequired: boolean
}

export interface MediaManifest {
  readonly source: string
  readonly slots: Readonly<Record<MediaSlot, SlotSpec>>
  readonly assets: readonly MediaAsset[]
}

const MEDIA_ROOT = join(import.meta.dirname, '..', '..', '..', 'assets', 'media')

let cached: MediaManifest | undefined

export function mediaRoot(): string {
  return MEDIA_ROOT
}

export function loadMediaManifest(): MediaManifest {
  if (cached !== undefined) return cached
  const raw = readFileSync(join(MEDIA_ROOT, 'manifest.json'), 'utf8')
  cached = JSON.parse(raw) as MediaManifest
  return cached
}

/** Assets in a slot, in manifest order. */
export function assetsForSlot(slot: MediaSlot): MediaAsset[] {
  return loadMediaManifest().assets.filter((asset) => asset.slot === slot)
}

export function assetByPath(path: string): MediaAsset {
  const asset = loadMediaManifest().assets.find((candidate) => candidate.path === path)
  if (asset === undefined) {
    throw new AppError('not_found', `No media asset at ${path}`, { details: { path } })
  }
  return asset
}

/**
 * The asset's bytes as a `data:` URL.
 *
 * The specimen page is rendered by `setContent` with no server, so an `<img src="assets/...">` would
 * resolve against `about:blank` and silently render nothing — and a screenshot of a page with
 * silently missing images looks like a design decision. Inlining removes the whole class of failure
 * from the harness. The real site serves files; this is for rendering without one.
 */
export function assetDataUrl(path: string): string {
  const asset = assetByPath(path)
  const bytes = readFileSync(join(MEDIA_ROOT, asset.path))
  const type = asset.path.endsWith('.png') ? 'image/png' : 'image/jpeg'
  return `data:${type};base64,${bytes.toString('base64')}`
}

/** `object-position` for an asset, so a crop keeps what matters in frame. */
export function focalPosition(asset: MediaAsset): string {
  return `${asset.focalX ?? 50}% ${asset.focalY ?? 50}%`
}

/** How far an asset's native ratio is from its slot's target, as a proportion. */
export function ratioDeviation(asset: MediaAsset, spec: SlotSpec): number {
  if (spec.ratio === null) return 0
  const target = spec.ratio[0] / spec.ratio[1]
  const native = asset.width / asset.height
  return Math.abs(native - target) / target
}
