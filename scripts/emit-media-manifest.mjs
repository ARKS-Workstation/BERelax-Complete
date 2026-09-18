#!/usr/bin/env node
/**
 * Regenerates `assets/media/manifest.json` by measuring every file in the library.
 *
 * Run it after adding or replacing a photograph. `pnpm media` then checks the result against disk on
 * every build, so a file swapped for a different crop fails there rather than turning up as a layout
 * that used to work.
 *
 * Focal points are the one thing it does not measure. It keeps whatever the existing manifest
 * declares and falls back to a slot default for a new asset — because where a face is in a frame is
 * not something a header tells you, and a default silently applied to nineteen portraits is exactly
 * the `Y12-photos` audit this records rather than pretends to have done.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', 'assets', 'media')
const MANIFEST = join(ROOT, 'manifest.json')

const SLOTS = {
  'therapist-portrait': { ratio: [4, 5], minWidth: 600, focalRequired: true },
  hero: { ratio: [16, 9], minWidth: 1280, focalRequired: true },
  logo: { ratio: null, minWidth: 240, focalRequired: false },
}

/** Full-length portraits put the face in roughly the top fifth; heroes are close to centred. */
const FOCAL_DEFAULTS = {
  'therapist-portrait': { focalX: 50, focalY: 16 },
  hero: { focalX: 50, focalY: 45 },
}

const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function jpegSize(bytes) {
  let index = 2
  while (index < bytes.length) {
    if (bytes[index] !== 0xff) {
      index += 1
      continue
    }
    const marker = bytes[index + 1]
    if (SOF.has(marker)) {
      return { height: bytes.readUInt16BE(index + 5), width: bytes.readUInt16BE(index + 7) }
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      index += 2
      continue
    }
    index += 2 + bytes.readUInt16BE(index + 2)
  }
  throw new Error('no SOF marker')
}

function walk(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) return walk(join(dir, entry.name), relative)
    return /\.(jpe?g|png)$/i.test(entry.name) ? [relative] : []
  })
}

function slotFor(path) {
  if (path.startsWith('team/')) return 'therapist-portrait'
  if (path.startsWith('logo/')) return 'logo'
  return 'hero'
}

let existing = { assets: [] }
try {
  existing = JSON.parse(readFileSync(MANIFEST, 'utf8'))
} catch {
  // First run.
}
const previous = new Map(existing.assets.map((asset) => [asset.path, asset]))

const assets = walk(ROOT)
  .sort()
  .map((path) => {
    const bytes = readFileSync(join(ROOT, path))
    const size = path.endsWith('.png')
      ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
      : jpegSize(bytes)
    const slot = slotFor(path)
    const prior = previous.get(path)
    const focal =
      prior?.focalX !== undefined && prior?.focalY !== undefined
        ? { focalX: prior.focalX, focalY: prior.focalY }
        : (FOCAL_DEFAULTS[slot] ?? {})
    return {
      path,
      slot,
      width: size.width,
      height: size.height,
      bytes: statSync(join(ROOT, path)).size,
      ...focal,
    }
  })

writeFileSync(
  MANIFEST,
  `${JSON.stringify({ source: existing.source ?? 'https://berelax.netlify.app/', slots: SLOTS, assets }, null, 2)}\n`,
)
console.log(`wrote assets/media/manifest.json — ${assets.length} assets measured`)
