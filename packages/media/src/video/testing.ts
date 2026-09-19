/**
 * Structural MP4 fixtures: real boxes, no footage.
 *
 * `probe.ts` reads facts out of MP4 bytes, and a parser is worth nothing until it has been pointed at a
 * file that is deliberately wrong. There is no real hero footage in this repository (`Y12-hero-video`) and
 * there is no ffmpeg in this container, so the files these functions build are the only way to assert
 * "moov after mdat is rejected" and "an `hev1` tag is rejected" as facts rather than as intentions.
 *
 * **What these are not.** They are not footage and they are not video: `mdat` holds a deterministic byte
 * pattern, no sample is decodable, and every file carries a `free` box containing `STAND_IN_MARKER` in
 * plain ASCII. A file that escaped into a bucket would announce itself in the first 128 bytes, which is
 * the difference between a fixture and a thing that can be mistaken for the real one.
 *
 * A non-test module for the same reason `apps/worker/src/testing/harness.ts` is one: two copies of a byte
 * format are two byte formats, and the copy in the test file is the one that rots.
 */

/**
 * The marker every synthetic artefact in this unit carries.
 *
 * `Y12-hero-video` is the OPEN-QUESTIONS id, so anything holding these bytes is one grep away from the
 * reason it exists and from who resolves it.
 */
export const STAND_IN_MARKER = 'BERELAX-STAND-IN-NOT-REAL-FOOTAGE-Y12-hero-video'

function box(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + payload.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, out.length)
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index)
  out.set(payload, 8)
  return out
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function u32(...values: readonly number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4)
  const view = new DataView(out.buffer)
  for (const [index, value] of values.entries()) view.setUint32(index * 4, value)
  return out
}

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index)
  return out
}

export interface StandInMp4Options {
  /** The `stsd` sample-entry 4cc. `hvc1` for a correct HEVC rendition, `hev1` for the known-bad one. */
  readonly codecTag?: string
  /** False puts `mdat` before `moov`, which is what a file with no faststart rewrite looks like. */
  readonly faststart?: boolean
  readonly durationSeconds?: number
  readonly timescale?: number
  readonly width?: number
  readonly height?: number
  readonly frameRate?: number
  /** Pads `mdat` so a byte-cap or budget assertion has a file of a chosen weight to measure. */
  readonly padToBytes?: number
}

/**
 * A structurally valid, deliberately undecodable MP4.
 *
 * `ftyp`, a `free` box carrying the stand-in marker, a `moov` with the one `trak` `probe.ts` walks, and an
 * `mdat` of filler. Every field the parser reads is a real field at its real offset — `mvhd` version 0,
 * `tkhd` 16.16 fixed-point geometry, `mdhd` timescale and duration, `stsz` sample count — so a parser that
 * reads the wrong offset fails here rather than in production against a file nobody kept.
 */
export function standInMp4(options: StandInMp4Options = {}): Uint8Array {
  const codecTag = options.codecTag ?? 'avc1'
  const timescale = options.timescale ?? 1000
  const seconds = options.durationSeconds ?? 3
  const width = options.width ?? 1920
  const height = options.height ?? 1080
  const frameRate = options.frameRate ?? 25
  const units = Math.round(seconds * timescale)
  const samples = Math.max(1, Math.round(seconds * frameRate))

  const ftyp = box('ftyp', concat([ascii('isom'), u32(0x200), ascii('isomiso2mp41')]))
  const marker = box('free', ascii(STAND_IN_MARKER))

  // mvhd version 0: creation, modification, timescale, duration, then the fields no reader here touches.
  const mvhd = box('mvhd', concat([u32(0), u32(0, 0, timescale, units), new Uint8Array(80)]))

  // tkhd version 0: 4 bytes version/flags, then 72 bytes to the 16.16 width and height.
  const tkhdGeometry = new Uint8Array(8)
  new DataView(tkhdGeometry.buffer).setUint32(0, width * 65536)
  new DataView(tkhdGeometry.buffer).setUint32(4, height * 65536)
  const tkhd = box('tkhd', concat([u32(0), new Uint8Array(72), tkhdGeometry]))

  // mdhd version 0: creation, modification, timescale, duration, language, quality.
  const mdhd = box('mdhd', concat([u32(0), u32(0, 0, timescale, units), u32(0)]))

  // One sample entry, whose box *type* is the codec tag the probe reads.
  const sampleEntry = box(codecTag, new Uint8Array(78))
  const stsd = box('stsd', concat([u32(0), u32(1), sampleEntry]))
  const stsz = box('stsz', concat([u32(0), u32(0), u32(samples)]))
  const stbl = box('stbl', concat([stsd, stsz]))
  const minf = box('minf', stbl)
  const mdia = box('mdia', concat([mdhd, minf]))
  const trak = box('trak', concat([tkhd, mdia]))
  const moov = box('moov', concat([mvhd, trak]))

  const head = concat([ftyp, marker])
  const fixed = head.length + moov.length + 8
  const filler = Math.max(16, (options.padToBytes ?? fixed + 16) - fixed)
  const mdat = box('mdat', new Uint8Array(filler).fill(0x5a))

  return options.faststart === false ? concat([head, mdat, moov]) : concat([head, moov, mdat])
}
