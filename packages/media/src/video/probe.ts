/**
 * Reading an MP4 back out of its own bytes: box order, codec tag, duration.
 *
 * ## Why this is a parser and not a call to ffprobe
 *
 * The acceptance for this unit is explicit — "faststart verified by reading box order, **not by trusting
 * the flag**". `-movflags +faststart` is a request: ffmpeg honours it by rewriting the file after the
 * encode, and there are real ways for that rewrite not to happen (a fragmented output, a muxer that does
 * not support it, a `-f` that is not `mp4`) in which the flag was passed, the exit status was zero and
 * `moov` is at the end. A file whose `moov` follows its `mdat` cannot start playing until the whole
 * download has finished, which on a hero loop is the entire point of deferring it.
 *
 * The same argument applies to `hvc1`. `-tag:v hvc1` is a request; the fact is four characters inside
 * the `stsd` box. Safari's behaviour when the fact is `hev1` is to ignore the track silently — no error
 * event, no `playing` event, the poster simply stays — so this is precisely the class of defect that a
 * successful command and a green log line will not reveal.
 *
 * So the evidence is the bytes. ffprobe is still run, in `encode.ts`, and the two are required to
 * **agree**: a disagreement means one of them is wrong and the job stops rather than picking a winner.
 *
 * ## Pure
 *
 * No `node:*`, no `sharp`, no I/O. It takes a `Uint8Array` and returns facts, which is what lets the same
 * parser be used by the worker, by a test with a hand-built fixture, and — if it is ever wanted — by an
 * admin screen that wants to say why an upload was refused.
 *
 * ## ISO BMFF, only as much as is needed
 *
 * A box is a 4-byte big-endian size, a 4-byte type, then its payload. `size === 1` means the real size is
 * a 64-bit value in the next eight bytes; `size === 0` means "to the end of the file". Container boxes
 * hold boxes; `moov/trak/mdia/minf/stbl` are the five this file walks through to reach `stsd`, and
 * `mvhd`/`mdhd` are read for their timescale and duration. Nothing here decodes a sample.
 */
import { AppError } from '@berelax/shared'

/** The largest box payload this parser will walk into. A 4GiB `moov` is a corrupt file, not a long one. */
const MAX_CONTAINER_BYTES = 64 * 1024 * 1024

/** Boxes that contain boxes, on the one path this parser needs. */
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl'])

export interface Mp4Box {
  readonly type: string
  /** Offset of the box header within the buffer. */
  readonly offset: number
  /** Total size including the header. */
  readonly size: number
  /** Offset of the first payload byte. */
  readonly payload: number
}

function readType(bytes: Uint8Array, at: number): string {
  let type = ''
  for (let index = at; index < at + 4; index += 1) {
    type += String.fromCharCode(bytes[index] ?? 0)
  }
  return type
}

function readU32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) << 24) +
    ((bytes[at + 1] ?? 0) << 16) +
    ((bytes[at + 2] ?? 0) << 8) +
    (bytes[at + 3] ?? 0)
  )
}

function readU64(bytes: Uint8Array, at: number): number {
  // Two 32-bit halves rather than a BigInt: a media duration that needs more than 53 bits of mantissa is
  // not a duration. The high half is kept in the arithmetic so a genuinely enormous value is visibly
  // enormous rather than silently truncated to its low word.
  return readU32(bytes, at) * 2 ** 32 + readU32(bytes, at + 4)
}

/**
 * The boxes directly inside a byte range, in file order.
 *
 * Order is the whole point for `moov`/`mdat`, so this returns a list rather than a map — a map would
 * lose exactly the fact being asserted.
 */
export function readBoxes(bytes: Uint8Array, from = 0, to = bytes.length): readonly Mp4Box[] {
  const boxes: Mp4Box[] = []
  let at = from
  while (at + 8 <= to) {
    const declared = readU32(bytes, at)
    const type = readType(bytes, at + 4)
    let size = declared
    let payload = at + 8
    if (declared === 1) {
      size = readU64(bytes, at + 8)
      payload = at + 16
    } else if (declared === 0) {
      size = to - at
    }
    if (size < 8 || at + size > to) {
      // A size that runs past the end is a truncated or mis-parsed file. Returning what was read so far
      // would make a truncated MP4 indistinguishable from a short one, and `assertFaststart` would then
      // report "no mdat" for a file that has one.
      throw new AppError(
        'validation',
        `[mp4-box-runs-past-end] box '${type}' at ${at} declares ${size} bytes and only ${to - at} remain`,
        { details: { type, offset: at, size, remaining: to - at } },
      )
    }
    boxes.push({ type, offset: at, size, payload })
    at += size
  }
  return boxes
}

/** The first box of a type directly inside a range. */
function findBox(bytes: Uint8Array, type: string, from: number, to: number): Mp4Box | undefined {
  return readBoxes(bytes, from, to).find((box) => box.type === type)
}

/**
 * Walks a `/`-separated box path, e.g. `moov/trak/mdia/minf/stbl/stsd`.
 *
 * Refuses to descend into a box it does not know to be a container, because a `stsd` payload begins with
 * a version and an entry count rather than a box, and a parser that guessed would read the entry count as
 * a box size and walk off into the sample table.
 */
export function findBoxPath(bytes: Uint8Array, path: readonly string[]): Mp4Box | undefined {
  let from = 0
  let to = bytes.length
  let found: Mp4Box | undefined
  for (const [index, type] of path.entries()) {
    const box = findBox(bytes, type, from, to)
    if (box === undefined) return undefined
    found = box
    if (index === path.length - 1) break
    if (!CONTAINERS.has(type)) return undefined
    if (box.size > MAX_CONTAINER_BYTES) {
      throw new AppError(
        'validation',
        `[mp4-container-implausibly-large] '${type}' declares ${box.size} bytes`,
        { details: { type, size: box.size } },
      )
    }
    from = box.payload
    to = box.offset + box.size
  }
  return found
}

/** The top-level box types, in file order. The evidence for faststart. */
export function topLevelBoxOrder(bytes: Uint8Array): readonly string[] {
  return readBoxes(bytes).map((box) => box.type)
}

export interface FaststartVerdict {
  readonly order: readonly string[]
  readonly moovIndex: number
  readonly mdatIndex: number
  readonly faststart: boolean
}

export function readFaststart(bytes: Uint8Array): FaststartVerdict {
  const order = topLevelBoxOrder(bytes)
  const moovIndex = order.indexOf('moov')
  const mdatIndex = order.indexOf('mdat')
  return {
    order,
    moovIndex,
    mdatIndex,
    faststart: moovIndex !== -1 && mdatIndex !== -1 && moovIndex < mdatIndex,
  }
}

/**
 * Refuses an MP4 whose index is behind its data.
 *
 * Separate rule names for "no index at all" and "index in the wrong place", because they are different
 * failures with different causes: the first is a muxer that produced a fragmented file, the second is a
 * faststart rewrite that did not run.
 */
export function assertFaststart(bytes: Uint8Array, label: string): void {
  const verdict = readFaststart(bytes)
  if (verdict.moovIndex === -1 || verdict.mdatIndex === -1) {
    throw new AppError(
      'invariant_violated',
      `[mp4-has-no-moov-and-mdat] ${label}: top-level boxes are ${verdict.order.join(', ') || 'none'} — a ` +
        'progressive MP4 must have both, and a fragmented one cannot be served with Range requests',
      { details: { label, order: verdict.order } },
    )
  }
  if (!verdict.faststart) {
    throw new AppError(
      'invariant_violated',
      `[mp4-moov-after-mdat] ${label}: moov is box ${verdict.moovIndex} and mdat is box ` +
        `${verdict.mdatIndex}, so playback cannot begin until the whole file has downloaded. ` +
        '`-movflags +faststart` was requested; the box order says the rewrite did not happen.',
      { details: { label, order: verdict.order } },
    )
  }
}

/**
 * The sample-entry 4cc of the first video track.
 *
 * `stsd` is `version(1) flags(3) entryCount(4)` and then the entries, each of which is itself a box whose
 * type *is* the codec tag — `avc1`, `hvc1`, `hev1`, `vp09`. So the tag is the type of the first box after
 * the eight-byte header, which is why this reads a box rather than searching for a string: `hvc1` appears
 * inside `hvcC` payloads and inside `ftyp` compatible-brand lists, and a substring search finds those.
 */
export function readCodecTag(bytes: Uint8Array): string | undefined {
  const stsd = findBoxPath(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsd'])
  if (stsd === undefined) return undefined
  const entries = readBoxes(bytes, stsd.payload + 8, stsd.offset + stsd.size)
  return entries[0]?.type
}

export function assertCodecTag(bytes: Uint8Array, expected: string, label: string): void {
  const actual = readCodecTag(bytes)
  if (actual === expected) return
  throw new AppError(
    'invariant_violated',
    `[mp4-codec-tag-unexpected] ${label}: the first video sample entry is '${actual ?? 'absent'}' and ` +
      `this rendition must be '${expected}'. An HEVC track tagged 'hev1' is legal and Safari ignores it ` +
      'without firing an error, so the poster stays and nothing reports why.',
    { details: { label, expected, actual } },
  )
}

export interface Mp4Duration {
  readonly timescale: number
  readonly units: number
  readonly seconds: number
}

/**
 * The movie duration from `mvhd`.
 *
 * Version 1 widens creation time, modification time and duration to 64 bits and leaves the timescale at
 * 32; version 0 keeps all four at 32. Reading the wrong layout does not fail, it returns a plausible
 * wrong number — which is why the version byte is read rather than assumed.
 */
export function readDuration(bytes: Uint8Array): Mp4Duration | undefined {
  const mvhd = findBoxPath(bytes, ['moov', 'mvhd'])
  if (mvhd === undefined) return undefined
  const version = bytes[mvhd.payload] ?? 0
  const at = mvhd.payload + 4
  const timescale = version === 1 ? readU32(bytes, at + 16) : readU32(bytes, at + 8)
  const units = version === 1 ? readU64(bytes, at + 20) : readU32(bytes, at + 12)
  if (timescale === 0) return undefined
  return { timescale, units, seconds: units / timescale }
}

export interface Mp4Probe {
  readonly bytes: number
  readonly boxOrder: readonly string[]
  readonly faststart: boolean
  readonly codecTag: string | undefined
  readonly duration: Mp4Duration | undefined
}

/** Everything this parser knows about a file, in one pass a caller can log. */
export function probeMp4(bytes: Uint8Array): Mp4Probe {
  const faststart = readFaststart(bytes)
  return {
    bytes: bytes.length,
    boxOrder: faststart.order,
    faststart: faststart.faststart,
    codecTag: readCodecTag(bytes),
    duration: readDuration(bytes),
  }
}

/**
 * The ping-pong duration assertion: twice the master, within one frame.
 *
 * "±1 frame" needs a frame period, and the only one available from `mvhd` alone is the movie timescale —
 * so the tolerance is taken as one frame at the declared frame rate, passed in by the caller because the
 * master's rate is a property of the master and not of this box. A tolerance of "one timescale unit"
 * would be 1/1000th of a second on a typical file, which is tighter than the concat filter's own rounding
 * and would fail on a correct encode.
 */
export function assertPingPongDuration(input: {
  readonly master: Mp4Duration
  readonly rendition: Mp4Duration
  readonly frameRate: number
  readonly label: string
}): void {
  const expected = input.master.seconds * 2
  const tolerance = 1 / input.frameRate
  const drift = Math.abs(input.rendition.seconds - expected)
  if (drift <= tolerance) return
  throw new AppError(
    'invariant_violated',
    `[ping-pong-duration-wrong] ${input.label}: the rendition runs ${input.rendition.seconds.toFixed(4)}s ` +
      `and twice the master is ${expected.toFixed(4)}s, a drift of ${drift.toFixed(4)}s against a ` +
      `one-frame tolerance of ${tolerance.toFixed(4)}s. Either the reverse leg was dropped or the concat ` +
      'did not run, and the loop then cuts rather than turning.',
    { details: { ...input, expected, drift, tolerance } },
  )
}

export interface FrameComparison {
  readonly pixels: number
  /** Channel samples whose absolute difference exceeds the tolerance. */
  readonly differing: number
  /** The largest absolute channel difference seen. */
  readonly maxDelta: number
  readonly seamless: boolean
}

/**
 * Compares two decoded frames channel by channel.
 *
 * The acceptance asks that the extracted last frame match the first "within a per-pixel tolerance", and a
 * tolerance is unavoidable: both frames go through a lossy encode, so an exact match would only ever
 * happen on a synthetic flat colour. `tolerance` is the per-channel ceiling and `maxDifferingRatio` the
 * share of samples allowed to exceed it — two numbers rather than one, because a single outlying pixel
 * from chroma subsampling is not a broken loop and a whole frame off by two is.
 *
 * Pure, and separated from the extraction on purpose: extracting two frames is two ffmpeg invocations
 * whose correctness is visible, and *this* is the part that can be subtly wrong and pass.
 */
export function compareFrames(
  a: Uint8Array,
  b: Uint8Array,
  options: { readonly tolerance: number; readonly maxDifferingRatio: number },
): FrameComparison {
  if (a.length !== b.length) {
    throw new AppError(
      'invariant_violated',
      `[frame-size-mismatch] frames are ${a.length} and ${b.length} bytes; a comparison across two ` +
        'geometries would report a difference that is a resize rather than a cut',
      { details: { a: a.length, b: b.length } },
    )
  }
  let differing = 0
  let maxDelta = 0
  for (let index = 0; index < a.length; index += 1) {
    const delta = Math.abs((a[index] ?? 0) - (b[index] ?? 0))
    if (delta > maxDelta) maxDelta = delta
    if (delta > options.tolerance) differing += 1
  }
  return {
    pixels: a.length,
    differing,
    maxDelta,
    seamless: a.length > 0 && differing / a.length <= options.maxDifferingRatio,
  }
}

export interface TrackSummary {
  readonly width: number
  readonly height: number
  /** Media timescale from `mdhd`, in units per second. */
  readonly timescale: number
  readonly durationSeconds: number
  readonly sampleCount: number
  /** Frames per second, derived. Zero when the track declares no samples. */
  readonly frameRate: number
}

/**
 * The first track's geometry, duration and frame count.
 *
 * Read from `tkhd`, `mdhd` and `stsz` rather than from ffprobe, for the same reason the codec tag is: the
 * job has to refuse a master that is too small or too long *before* it spends an hour on four `veryslow`
 * encodes, and it must be able to do that whether or not a probe binary is on the path.
 *
 * `tkhd`'s width and height are 16.16 fixed point and are the *display* dimensions, which is what a
 * player lays out — a track with a non-square pixel aspect ratio has coded dimensions that differ, and
 * cropping against the coded ones would cut the wrong window. The version byte decides the field layout;
 * reading the wrong one returns a plausible wrong number rather than failing, which is why it is read.
 */
export function readTrackSummary(bytes: Uint8Array): TrackSummary | undefined {
  const tkhd = findBoxPath(bytes, ['moov', 'trak', 'tkhd'])
  const mdhd = findBoxPath(bytes, ['moov', 'trak', 'mdia', 'mdhd'])
  if (tkhd === undefined || mdhd === undefined) return undefined

  const tkhdVersion = bytes[tkhd.payload] ?? 0
  const geometryAt = tkhd.payload + 4 + (tkhdVersion === 1 ? 84 : 72)
  const width = readU32(bytes, geometryAt) / 65536
  const height = readU32(bytes, geometryAt + 4) / 65536

  const mdhdVersion = bytes[mdhd.payload] ?? 0
  const mdhdAt = mdhd.payload + 4
  const timescale = mdhdVersion === 1 ? readU32(bytes, mdhdAt + 16) : readU32(bytes, mdhdAt + 8)
  const units = mdhdVersion === 1 ? readU64(bytes, mdhdAt + 20) : readU32(bytes, mdhdAt + 12)
  const durationSeconds = timescale === 0 ? 0 : units / timescale

  const stsz = findBoxPath(bytes, ['moov', 'trak', 'mdia', 'minf', 'stbl', 'stsz'])
  const sampleCount = stsz === undefined ? 0 : readU32(bytes, stsz.payload + 8)

  return {
    width: Math.round(width),
    height: Math.round(height),
    timescale,
    durationSeconds,
    sampleCount,
    frameRate: durationSeconds === 0 ? 0 : sampleCount / durationSeconds,
  }
}

export interface Y4mHeader {
  readonly width: number
  readonly height: number
  readonly frameRate: number
  readonly colourSpace: string
  /** Every `X`-prefixed extension parameter, which is where a stand-in declares itself. */
  readonly extensions: readonly string[]
}

/**
 * The header of a YUV4MPEG2 stream.
 *
 * One line of ASCII, space-separated tagged parameters, terminated by a newline: `W`, `H`,
 * `F<num>:<den>`, `I`, `A`, `C`, and any number of `X` extensions. It is read here because the stand-in
 * master this unit ships is a y4m — there is no real hero footage (`Y12-hero-video`) — and its frame
 * geometry, its rate and its **stand-in marker** all have to be checkable without decoding anything.
 */
export function readY4mHeader(bytes: Uint8Array): Y4mHeader | undefined {
  const limit = Math.min(bytes.length, 512)
  let line = ''
  for (let index = 0; index < limit; index += 1) {
    const code = bytes[index] ?? 0
    if (code === 0x0a) break
    line += String.fromCharCode(code)
  }
  if (!line.startsWith('YUV4MPEG2 ')) return undefined
  const parameters = line.split(' ').slice(1)
  const value = (tag: string): string | undefined =>
    parameters.find((parameter) => parameter.startsWith(tag))?.slice(tag.length)
  const width = Number.parseInt(value('W') ?? '', 10)
  const height = Number.parseInt(value('H') ?? '', 10)
  const [numerator = '0', denominator = '1'] = (value('F') ?? '').split(':')
  const rate = Number(numerator) / Number(denominator)
  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isFinite(rate)) {
    return undefined
  }
  return {
    width,
    height,
    frameRate: rate,
    colourSpace: value('C') ?? '',
    extensions: parameters.filter((parameter) => parameter.startsWith('X')).map((p) => p.slice(1)),
  }
}
