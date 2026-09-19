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
 *
 * **What the constraints are, and where they live.** W-SYS-09 moved them out of this file. Every asset is
 * now measured by `validateUpload` against `packages/media/src/slots/registry.ts` — the one declaration of
 * a slot's ratio, minimum dimensions, byte cap, mime types and alt requirement — so the library is held to
 * exactly the constraints a real upload is. This file used to carry its own minimum width and its own
 * ratio tolerance, and consequently never looked at the byte cap or the mime type at all. Each violation
 * arrives with the rule name `validateUpload` gave it.
 *
 * `[slot-spec-must-mirror-the-registry]` is the other half: the manifest's `slots` block is a projection
 * of the registry, committed so a change to a ratio or a cap is visible in a diff, and this fails when the
 * committed file is not what `pnpm media:emit` would write. The same arrangement as `tokens.css`.
 *
 * `[aspect-ratio-must-come-from-the-slot-registry]` is the third source rule, and the reason the registry
 * can be called single: a component that writes `aspect-ratio: 4 / 5` has made a second copy of a number
 * the crop also depends on, and the symptom is a card reserving the wrong box and reflowing when the
 * photograph lands. See the rule's own note below.
 *
 * Two further rules, added by W-SYS-05, are about how the library is *referenced* rather than what is in
 * it. Both are reported with their rule name first, so `scripts/test-gates.mjs` can assert a known-bad
 * fixture was rejected by the rule written for it rather than by an unrelated one (ADR 0003).
 *
 * **`[no-blurhash]`.** docs/08 §6 chose a flat OKLCH placeholder over a blurhash, on the grounds that a
 * blurhash costs a dependency, a decoder and a canvas paint per image and buys a smear of the photograph.
 * A decision not to add something is the kind a dependency silently reverses, so the absence is checked:
 * no package may depend on one, and no source file may mention one.
 *
 * **`[no-private-origin-url]`.** Originals live in a private bucket with no CDN and no public read, and
 * derivatives are served same-origin (docs/08 §6). Neither `/originals/` nor a `digitaloceanspaces.com`
 * hostname may appear in source. The private half is about consent — the nineteen portraits are
 * photographs of real employees, and `Y12-consent-photo` is open — and the same-origin half is the
 * requests-to-LCP budget in docs/08 §8, which a third-party origin spends on DNS, TCP and TLS before the
 * first byte of the hero.
 *
 * Both source rules skip `*.test.ts` and `*.itest.ts`, the same exemption `scripts/check-job-registry.mjs`
 * makes and for the same reason: the tests that prove a private path is *rejected* have to contain one.
 * Nothing in a test is served, and the dependency half of `[no-blurhash]` covers every package.json
 * whether or not a test mentions the name.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { validateUpload } from '../packages/media/src/slots/validate.ts'
import { manifestSlotSpecs } from './lib/media-slot-specs.mjs'
import { stripNonCode } from './lib/strip-non-code.mjs'

const REPO = join(import.meta.dirname, '..')
const ROOT = join(REPO, 'assets', 'media')
const MANIFEST = join(ROOT, 'manifest.json')

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

  // Every committed asset is run through the same validator a real upload goes through (W-SYS-09), so
  // the library is held to the constraints the slot registry declares rather than to a second, looser
  // set written here. That is what caught the previous arrangement: this file checked minimum width and
  // a ratio tolerance of its own and never looked at the byte cap or the mime type at all.
  const focal =
    asset.focalX === undefined || asset.focalY === undefined
      ? undefined
      : { x: asset.focalX, y: asset.focalY }
  for (const violation of validateUpload({
    slot: asset.slot,
    mimeType: asset.path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg',
    byteLength: actualBytes,
    width: size.width,
    height: size.height,
    filename: asset.path,
    ...(focal === undefined ? {} : { focal }),
  })) {
    problems.push(`${asset.path}  ${violation.message}`)
  }

  if (spec.focalRequired && focal === undefined) {
    // Stricter than the upload rule on purpose. The upload validator asks for a focal point only when
    // the source is a different shape from the slot; a library asset in a cropped slot must declare one
    // whatever its shape, because `assets/media/manifest.json` is what the renderer reads for
    // `object-position` and a missing one there is a silent centre crop.
    problems.push(`${asset.path} is in a cropped slot and declares no focal point`)
  }
}

// The manifest's slot block is a projection of the slot registry, committed so a change to a ratio or a
// byte cap is visible in a diff. Regenerate with `pnpm media:emit`.
{
  const expected = JSON.stringify(manifestSlotSpecs(), null, 2)
  const actual = JSON.stringify(manifest.slots, null, 2)
  if (expected !== actual) {
    problems.push(
      "[slot-spec-must-mirror-the-registry] assets/media/manifest.json's `slots` block is not what " +
        'packages/media/src/slots/registry.ts declares. A slot whose ratio, minimum dimensions, byte cap ' +
        'or mime types differ here from the registry is a library measured against constraints nothing ' +
        'else enforces. Run `pnpm media:emit`.',
    )
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

// ---------------------------------------------------------------------------------------------------
// How the library is referenced: `[no-blurhash]` and `[no-private-origin-url]`. See the file header.
// ---------------------------------------------------------------------------------------------------

const SOURCE_ROOTS = ['apps', 'packages']
const SKIP_DIRECTORIES = new Set(['.claude', 'node_modules', 'dist', '.next', 'artifacts'])
const SOURCE_EXTENSIONS = /\.(ts|tsx|css|mjs)$/
const TEST_FILE = /\.(test|itest)\.tsx?$/

/** The forbidden URL shapes, spelled once. */
const PRIVATE_ORIGIN = [
  { pattern: /\/originals\//, why: 'the private bucket holds originals; no URL may reach one' },
  {
    // W-SYS-06. docs/08 §6 puts "originals, video masters, signed consent PDFs" in the same private
    // bucket, and a video master is the heaviest object in it: a hero master is up to 128MiB, and a URL
    // that reached one would serve that instead of the 350KB rendition the page is budgeted for. Added as
    // its own spelling rather than widened out of `/originals/`, so a fixture proves each independently.
    pattern: /\/video-masters\//,
    why: 'the private bucket holds video masters; the page serves renditions, never a master',
  },
  {
    pattern: /digitaloceanspaces\.com/,
    why: 'derivatives are served same-origin; a Spaces host costs DNS, TCP and TLS before the hero',
  },
]

const BLURHASH = /\bblurhash\b/i

/**
 * The one file that may state a ratio: the registry itself.
 *
 * A single path rather than a directory, so the exemption cannot quietly widen — the same shape
 * `scripts/check-colour-tokens.mjs` uses for the token layer.
 */
const RATIO_SOURCE = new Set(['packages/media/src/slots/registry.ts'])

/**
 * `[aspect-ratio-must-come-from-the-slot-registry]`.
 *
 * Every slot's aspect ratio is declared once, in `packages/media/src/slots/registry.ts`, and a component
 * that writes the number instead of reading it is the second copy. The failure is not an error and not a
 * wrong-looking diff: it is a card that reserves a 4:5 box for a slot that has become 3:2, reflowing when
 * the photograph lands — a CLS regression nobody attributes to two digits in a stylesheet.
 *
 * So a literal ratio is refused and `slotAspectRatio('hero')` is the way through. Three forms are matched,
 * because all three are how it would actually be written:
 *
 *   - the CSS declaration, `aspect-ratio: 16 / 9`
 *   - the React style property, `aspectRatio: '16/9'`
 *   - Tailwind's utilities, `aspect-video`, `aspect-square`, `aspect-[4/5]`
 *
 * A value containing `var(` or a template hole is not a literal and is allowed: `var(--slot-ratio)` reads
 * a custom property somebody set from the registry, and `${slotAspectRatio(...)}` is the registry itself.
 */
const ASPECT_RATIO_FORMS = [
  /aspect-ratio\s*:\s*([^;}\n]+)/gi,
  /aspectRatio\s*:\s*([^,;}\n]+)/g,
  /\baspect-(square|video|\[[^\]]*\])/g,
]

/** A ratio nobody derived: digits, and no way for them to have come from the registry. */
function isLiteralRatio(value) {
  const text = value.trim()
  if (text.includes('var(') || text.includes('${') || text.includes('slotAspectRatio')) return false
  return /\d/.test(text) || /^(square|video)$/.test(text)
}

function* walkSource(dir, prefix) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue
    const full = join(dir, entry.name)
    const relative = `${prefix}/${entry.name}`
    if (entry.isDirectory()) yield* walkSource(full, relative)
    else yield { full, relative }
  }
}

const referenceProblems = []
let scanned = 0

for (const root of SOURCE_ROOTS) {
  for (const { full, relative } of walkSource(join(REPO, root), root)) {
    if (relative.endsWith('/package.json')) {
      const manifestJson = JSON.parse(readFileSync(full, 'utf8'))
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
        for (const name of Object.keys(manifestJson[field] ?? {})) {
          if (BLURHASH.test(name)) {
            referenceProblems.push(
              `${relative}  [no-blurhash] depends on '${name}' — docs/08 §6 chose a flat OKLCH ` +
                'placeholder, which costs no decoder and cannot flash a dark smear',
            )
          }
        }
      }
      continue
    }
    if (!SOURCE_EXTENSIONS.test(relative)) continue
    scanned += 1

    // Comments blanked, strings kept. Without this, the paragraph in `placeholder.ts` explaining why
    // blurhash was rejected is itself reported as a blurhash — the failure the colour gate hit first.
    const text = stripNonCode(readFileSync(full, 'utf8'), {
      lineComments: !relative.endsWith('.css'),
    })
    if (TEST_FILE.test(relative)) continue

    for (const [index, line] of text.split('\n').entries()) {
      const at = `${relative}:${index + 1}`
      if (BLURHASH.test(line)) {
        referenceProblems.push(
          `${at}  [no-blurhash] mentions a blurhash — the placeholder is one flat OKLCH colour ` +
            '(docs/08 §6), and a decision not to add a dependency is one a dependency reverses',
        )
      }
      for (const { pattern, why } of PRIVATE_ORIGIN) {
        const match = pattern.exec(line)
        if (match !== null) {
          referenceProblems.push(`${at}  [no-private-origin-url] '${match[0]}' — ${why}`)
        }
      }
      if (!RATIO_SOURCE.has(relative)) {
        for (const form of ASPECT_RATIO_FORMS) {
          form.lastIndex = 0
          let match = form.exec(line)
          while (match !== null) {
            if (isLiteralRatio(match[1] ?? '')) {
              referenceProblems.push(
                `${at}  [aspect-ratio-must-come-from-the-slot-registry] '${match[0].trim()}' — a slot's ` +
                  'aspect ratio is declared once, in packages/media/src/slots/registry.ts. Interpolate ' +
                  "slotAspectRatio('<slot>') instead: a second copy of the number reserves the wrong box " +
                  'and reflows when the photograph lands, which is a CLS regression nobody traces back to ' +
                  'a stylesheet',
              )
            }
            match = form.exec(line)
          }
        }
      }
    }
  }
}

if (referenceProblems.length > 0) {
  console.error('Media reference problems:\n')
  for (const problem of referenceProblems) console.error(`  ${problem}`)
  console.error(`\n${referenceProblems.length} problem(s).`)
  process.exit(1)
}

const portraits = manifest.assets.filter((asset) => asset.slot === 'therapist-portrait')
const ratios = portraits.map((asset) => asset.width / asset.height)
console.log(
  `Media library holds: ${manifest.assets.length} assets, all present and measured. ` +
    `${portraits.length} portraits span ratios ${Math.min(...ratios).toFixed(3)}–${Math.max(...ratios).toFixed(3)}, ` +
    'each with a focal point.',
)
console.log(
  `No blurhash and no private-origin URL across ${scanned} source files: the placeholder is one flat ` +
    'OKLCH colour, and every media URL is same-origin and content-addressed.',
)
