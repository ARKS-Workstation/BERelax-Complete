#!/usr/bin/env node
/**
 * The media library must match its manifest, and every cropped asset must declare a focal point.
 *
 * Both halves catch a failure that is invisible in code and obvious on screen.
 *
 * **Drift.** A file replaced with a different crop, or removed, or added and never registered. The
 * manifest carries dimensions and byte counts, so a swapped file fails here rather than appearing as
 * a layout that used to work.
 *
 * **Crop.** The nineteen staff portraits are full-length shots whose native ratios run from 0.461 to
 * 0.799 — a spread of nearly two to one — and the face sits in roughly the top fifth of the frame. A
 * grid at a fixed 4:5 with a centre crop produces a row of torsos. So an asset in a slot that crops
 * must say where the subject is, and this fails when one does not.
 *
 * Dimensions are read from the file headers directly. A dependency for that would be a dependency for
 * nothing: a JPEG SOF marker and a PNG IHDR are both a fixed offset away.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..', 'assets', 'media')
const MANIFEST = join(ROOT, 'manifest.json')

/** How far a native ratio may sit from its slot's target before the crop needs a stated focal point. */
const RATIO_TOLERANCE = 0.08

const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
])

function jpegSize(bytes) {
  let index = 2
  while (index < bytes.length) {
    if (bytes[index] !== 0xff) {
      index += 1
      continue
    }
    const marker = bytes[index + 1]
    if (SOF_MARKERS.has(marker)) {
      return { height: bytes.readUInt16BE(index + 5), width: bytes.readUInt16BE(index + 7) }
    }
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      index += 2
      continue
    }
    index += 2 + bytes.readUInt16BE(index + 2)
  }
  return undefined
}

function pngSize(bytes) {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

function walk(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) return walk(full, relative)
    return /\.(jpe?g|png)$/i.test(entry.name) ? [relative] : []
  })
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const problems = []
const onDisk = new Set(walk(ROOT))

for (const asset of manifest.assets) {
  const path = join(ROOT, asset.path)
  onDisk.delete(asset.path)

  let bytes
  try {
    bytes = readFileSync(path)
  } catch {
    problems.push(`${asset.path} is in the manifest and not on disk`)
    continue
  }

  const actualBytes = statSync(path).size
  if (actualBytes !== asset.bytes) {
    problems.push(
      `${asset.path} is ${actualBytes} bytes, the manifest says ${asset.bytes} — the file was replaced`,
    )
  }

  const size = asset.path.endsWith('.png') ? pngSize(bytes) : jpegSize(bytes)
  if (size === undefined) {
    problems.push(`${asset.path} has no readable dimensions`)
    continue
  }
  if (size.width !== asset.width || size.height !== asset.height) {
    problems.push(
      `${asset.path} is ${size.width}x${size.height}, the manifest says ${asset.width}x${asset.height}`,
    )
  }

  const spec = manifest.slots[asset.slot]
  if (spec === undefined) {
    problems.push(`${asset.path} is in slot '${asset.slot}', which the manifest does not define`)
    continue
  }
  if (size.width < spec.minWidth) {
    problems.push(
      `${asset.path} is ${size.width}px wide; slot '${asset.slot}' needs at least ${spec.minWidth}px`,
    )
  }
  if (spec.ratio !== null) {
    const target = spec.ratio[0] / spec.ratio[1]
    const native = size.width / size.height
    const deviation = Math.abs(native - target) / target
    const hasFocal = asset.focalX !== undefined && asset.focalY !== undefined
    if (deviation > RATIO_TOLERANCE && !hasFocal) {
      problems.push(
        `${asset.path} is ${native.toFixed(3)} against the slot's ${target.toFixed(3)} ` +
          `(${Math.round(deviation * 100)}% off) and declares no focal point — a centre crop will ` +
          'cut the subject out',
      )
    }
  }
  if (spec.focalRequired && (asset.focalX === undefined || asset.focalY === undefined)) {
    problems.push(`${asset.path} is in a cropped slot and declares no focal point`)
  }
}

for (const orphan of onDisk) {
  problems.push(`${orphan} is on disk and not in the manifest — nothing will ever render it`)
}

if (problems.length > 0) {
  console.error('Media library problems:\n')
  for (const problem of problems) console.error(`  ${problem}`)
  console.error(`\n${problems.length} problem(s). Regenerate the manifest, or fix the asset.`)
  process.exit(1)
}

const portraits = manifest.assets.filter((asset) => asset.slot === 'therapist-portrait')
const ratios = portraits.map((asset) => asset.width / asset.height)
console.log(
  `Media library holds: ${manifest.assets.length} assets, all present and measured. ` +
    `${portraits.length} portraits span ratios ${Math.min(...ratios).toFixed(3)}–${Math.max(...ratios).toFixed(3)}, ` +
    'each with a focal point.',
)
