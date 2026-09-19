/**
 * The encoder: finding ffmpeg, running it, and refusing to report a rendition that does not exist.
 *
 * ## ffmpeg is not here, and that is the first thing this file is about
 *
 * `which ffmpeg` in this container returns nothing. W-SYS-05 set the precedent that matters:
 * `MEDIA_STORAGE=real` throws `[no-real-media-storage-adapter]` rather than falling back to the fake,
 * because "the upload succeeded" is the one thing a storage adapter must never say without evidence. The
 * same applies twice over here. A missing encoder must not produce a skipped rendition, an empty file, or
 * a result object with four entries and no bytes behind them — so `resolveFfmpeg` throws
 * `[ffmpeg-not-available]` naming the directories it searched, and every path into an encode goes through
 * it.
 *
 * ## The licence of the binary is checked, not assumed
 *
 * The four renditions this unit is specified to produce need `-crf`, `-profile:v high` and HEVC, which in
 * practice means libx264 and libx265. Both are GPL-2.0-or-later, and ffmpeg cannot be configured with
 * either unless `--enable-gpl` is passed — at which point the ffmpeg binary is GPL too. That is a real
 * obligation on the image (see `apps/worker/licences/THIRD-PARTY-NOTICES.md` and the `imageComponents`
 * block in `build/container-policy.json`), and an obligation recorded against one binary is worthless if
 * the image quietly ships a different one. So the configuration string is read out of `ffmpeg -version`
 * and compared against what the notice covers: an unexpected licence is `[ffmpeg-build-licence-unexpected]`
 * and stops the job. It fires in both directions on purpose — an LGPL build is *less* obligation and still
 * makes the shipped notice wrong.
 *
 * ## And the encoders, by name
 *
 * `-c:v libx264` on a build without it fails; `-c:v h264` on the same build silently selects whatever
 * H.264 encoder is present, which on an LGPL build is OpenH264 — Constrained Baseline only, no CRF, and
 * therefore not the rendition anybody specified. The encoder is named explicitly and its presence is
 * asserted before the first encode, so "a rendition was produced" and "the rendition that was specified
 * was produced" are the same statement.
 */
import { execFile } from 'node:child_process'
import { accessSync, constants, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { AppError } from '@berelax/shared'
import { contentAddress, sha256Hex } from '../hash.ts'
import { type MediaSlotName, mediaSlot } from '../slots/registry.ts'
import {
  IMMUTABLE_CACHE_CONTROL,
  type MediaStorage,
  PRIVATE_CACHE_CONTROL,
  publicKeyFor,
} from '../storage/port.ts'
import {
  assertMasterAcceptable,
  assertWithinHardStop,
  CODEC_ENCODER,
  FORBIDDEN_CONTAINERS,
  type FocalPercent,
  ffmpegArgv,
  HERO_VIDEO_SLOT,
  isWithinBudget,
  type MasterMeasurement,
  overBudgetMessage,
  PRIVATE_VIDEO_MASTER_PREFIX,
  REQUIRED_CODEC_TAG,
  type SourceGeometry,
  VIDEO_CONTENT_TYPE,
  VIDEO_RENDITIONS,
  type VideoCodec,
  type VideoRendition,
  videoMasterKey,
  videoRenditionPath,
} from './ladder.ts'
import {
  assertCodecTag,
  assertFaststart,
  assertPingPongDuration,
  type Mp4Duration,
  probeMp4,
  readDuration,
  readTrackSummary,
  readY4mHeader,
} from './probe.ts'
import { STAND_IN_MARKER } from './testing.ts'

const run = promisify(execFile)

/**
 * The licences the image's notice covers.
 *
 * Two entries because Debian's ffmpeg is built `--enable-gpl` and, for the parts that require it,
 * `--enable-version3`; which of the two the binary reports depends on the configure line, and both are
 * covered by the same notice and the same written offer. Anything else is a build nobody reviewed.
 */
export const FFMPEG_DECLARED_LICENCES: readonly string[] = ['GPL-2.0-or-later', 'GPL-3.0-or-later']

export interface FfmpegTools {
  readonly ffmpegPath: string
  readonly ffprobePath: string
  /** The first line of `ffmpeg -version`, as reported. */
  readonly version: string
  /** The `configuration:` line. The evidence for the licence and for what is compiled in. */
  readonly configuration: string
  /** Derived from the configuration, never assumed. */
  readonly licence: string
  /** Encoder names `ffmpeg -encoders` lists. */
  readonly encoders: readonly string[]
}

export interface ResolveOptions {
  /** Directories to search, highest priority first. Defaults to `PATH`. */
  readonly searchPath?: readonly string[]
  /** Injected so a test can drive both the present and the absent case without touching the machine. */
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly timeoutMs?: number
}

function searchDirectories(options: ResolveOptions): readonly string[] {
  if (options.searchPath !== undefined) return options.searchPath
  const path = (options.env ?? process.env)['PATH'] ?? ''
  return path.split(':').filter((entry) => entry.length > 0)
}

function locate(name: string, directories: readonly string[]): string | undefined {
  for (const directory of directories) {
    const candidate = join(directory, name)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not here, or not executable. Either way the next directory is the answer.
    }
  }
  return undefined
}

/**
 * ffmpeg's licence, from its own configuration line.
 *
 * `--enable-gpl` is what admits libx264 and libx265, and it is what makes the binary GPL. `--enable-version3`
 * upgrades the parts that permit it. The mapping is small and it is the whole basis of the obligation
 * recorded in the container policy, so it is a function with a test rather than a comment.
 */
export function detectFfmpegLicence(configuration: string): string {
  const gpl = /--enable-gpl\b/.test(configuration)
  const version3 = /--enable-version3\b/.test(configuration)
  if (gpl) return version3 ? 'GPL-3.0-or-later' : 'GPL-2.0-or-later'
  return version3 ? 'LGPL-3.0-or-later' : 'LGPL-2.1-or-later'
}

/**
 * Finds ffmpeg and ffprobe, reads what they are, and refuses anything unexpected by name.
 *
 * Four distinct refusals rather than one, because they have four different remedies: install ffmpeg, fix a
 * half-installed one, reconcile the image notice with the binary, or install a build with the encoders the
 * renditions need.
 */
export async function resolveFfmpeg(options: ResolveOptions = {}): Promise<FfmpegTools> {
  const directories = searchDirectories(options)
  const ffmpegPath = locate('ffmpeg', directories)
  if (ffmpegPath === undefined) {
    throw new AppError(
      'invariant_violated',
      '[ffmpeg-not-available] no executable `ffmpeg` on the search path, so no hero video rendition can ' +
        'be produced. The worker image installs it (apps/worker/Dockerfile); a local run needs it on ' +
        `PATH. Searched: ${directories.join(', ') || '(empty PATH)'}. Reporting a rendition this process ` +
        'did not encode would be the failure docs/12 §1 prohibits.',
      { details: { searched: directories } },
    )
  }
  const ffprobePath = locate('ffprobe', directories)
  if (ffprobePath === undefined) {
    throw new AppError(
      'invariant_violated',
      '[ffprobe-not-available] `ffmpeg` is on the path and `ffprobe` is not. ffprobe is the independent ' +
        'reading of what was produced: the byte parser in probe.ts and ffprobe are required to agree, and ' +
        'with only one of them there is nothing to agree with.',
      { details: { ffmpegPath, searched: directories } },
    )
  }

  const timeout = options.timeoutMs ?? 30_000
  const { stdout, stderr } = await run(ffmpegPath, ['-hide_banner', '-version'], {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  })
  const banner = `${stdout}${stderr}`
  const version = banner.split('\n')[0]?.trim() ?? ''
  const configuration = /configuration:([^\n]*)/.exec(banner)?.[1]?.trim() ?? ''
  const licence = detectFfmpegLicence(configuration)
  if (!FFMPEG_DECLARED_LICENCES.includes(licence)) {
    throw new AppError(
      'invariant_violated',
      `[ffmpeg-build-licence-unexpected] this ffmpeg reports ${licence} and the image's third-party ` +
        `notice covers ${FFMPEG_DECLARED_LICENCES.join(' or ')}. A licence obligation recorded against one ` +
        'binary says nothing about a different one — reconcile ' +
        'apps/worker/licences/THIRD-PARTY-NOTICES.md and build/container-policy.json with the build ' +
        'actually installed before encoding anything.',
      { details: { licence, declared: FFMPEG_DECLARED_LICENCES, configuration } },
    )
  }

  const encoderList = await run(ffmpegPath, ['-hide_banner', '-encoders'], {
    timeout,
    maxBuffer: 8 * 1024 * 1024,
  })
  const encoders = [
    // `[ \t]` and not `\s`: `\s` matches a newline, so the `Encoders:` header row consumed the line break
    // and the first encoder's line was read as that header's second column — which silently dropped
    // libx264 from the list while libx265 was still found.
    ...`${encoderList.stdout}${encoderList.stderr}`.matchAll(/^[ \t]*\S+[ \t]+(\S+)/gm),
  ].map((match) => match[1] ?? '')
  const missing = [...new Set(Object.values(CODEC_ENCODER))].filter(
    (encoder) => !encoders.includes(encoder),
  )
  if (missing.length > 0) {
    throw new AppError(
      'invariant_violated',
      `[video-encoder-not-available] this ffmpeg has no ${missing.join(' and no ')}. The renditions are ` +
        'specified with -crf and -profile:v high, which are x264/x265 options; naming a generic `h264` ' +
        'encoder instead would silently select whatever is present and produce a file nobody specified.',
      { details: { missing, licence, version } },
    )
  }

  return { ffmpegPath, ffprobePath, version, configuration, licence, encoders }
}

export interface EncodeRequest {
  readonly rendition: VideoRendition
  readonly master: Uint8Array
  /** The master's container extension, so ffmpeg reads it as what it is. */
  readonly masterExtension: string
  readonly source: SourceGeometry
  readonly focal: FocalPercent
}

/**
 * The encoder, and the encode counter only it can move.
 *
 * Exactly the shape `derivatives.ts` uses, and for the same reason W-SYS-05 gives: the acceptance is "a
 * second run re-encodes nothing (encode counter 0)", and that claim is worthless if the number is
 * maintained by the loop that decides whether to skip — the loop would be asserting its own branch. Here
 * the only way the count rises is that an encoder produced bytes.
 */
export interface VideoEncoder {
  /** What produced these bytes, for the job's log line and for the result. Never a guess. */
  readonly describe: string
  encode(request: EncodeRequest): Promise<Uint8Array>
  count(): number
}

export interface FfmpegEncoderOptions {
  /** Seconds one rendition may take. Four `veryslow` encodes is the reason this is generous. */
  readonly timeoutMs?: number
  readonly scratchDirectory?: string
}

/** The real encoder. ffmpeg in, bytes out, nothing reported that was not read back off disk. */
export function createFfmpegEncoder(
  tools: FfmpegTools,
  options: FfmpegEncoderOptions = {},
): VideoEncoder {
  let encodes = 0
  return {
    describe: `${tools.version} (${tools.licence})`,
    count: () => encodes,
    async encode(request: EncodeRequest): Promise<Uint8Array> {
      const scratch = mkdtempSync(join(options.scratchDirectory ?? tmpdir(), 'berelax-video-'))
      try {
        const inputPath = join(scratch, `master.${request.masterExtension}`)
        const outputPath = join(scratch, 'rendition.mp4')
        writeFileSync(inputPath, request.master)
        await run(tools.ffmpegPath, [...ffmpegArgv({ ...request, inputPath, outputPath })], {
          timeout: options.timeoutMs ?? 3_600_000,
          maxBuffer: 8 * 1024 * 1024,
        })
        // Read back, always. An exit status of zero and a file of zero bytes is a real ffmpeg outcome
        // when a filter graph produces no frames, and it is indistinguishable from success to a caller
        // that trusts the exit code.
        const bytes = readFileSync(outputPath)
        if (bytes.length === 0) {
          throw new AppError(
            'invariant_violated',
            `[video-encode-produced-nothing] ffmpeg exited zero and wrote an empty file for ` +
              `${request.rendition.crop}/${request.rendition.codec}`,
            { details: { rendition: request.rendition } },
          )
        }
        encodes += 1
        return bytes
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    },
  }
}

export interface FfprobeStream {
  readonly codec_name?: string
  readonly codec_tag_string?: string
  readonly width?: number
  readonly height?: number
  readonly nb_frames?: string
  readonly duration?: string
}

/**
 * ffprobe's reading of a file, for the cross-check.
 *
 * The acceptance names ffprobe; `probe.ts` reads the same facts out of the bytes. Running both and
 * requiring them to **agree** is stronger than either: a byte parser reading the wrong offset and an
 * ffprobe invocation pointed at the wrong file both fail, and neither can be the only witness.
 */
export async function ffprobeStreams(
  tools: FfmpegTools,
  path: string,
  timeoutMs = 60_000,
): Promise<readonly FfprobeStream[]> {
  const { stdout } = await run(
    tools.ffprobePath,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-select_streams',
      'v',
      '-show_streams',
      '-print_format',
      'json',
      path,
    ],
    { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
  )
  const parsed = JSON.parse(stdout) as { streams?: readonly FfprobeStream[] }
  return parsed.streams ?? []
}

export interface MasterDescription extends MasterMeasurement {
  /** True when the master carries the stand-in marker. Reported, never hidden. */
  readonly standIn: boolean
  readonly frameRate: number
  readonly extension: string
  readonly duration: Mp4Duration
}

/**
 * Measures a master from its own bytes.
 *
 * Both container shapes this pipeline accepts are readable without a decoder: an MP4's `tkhd`/`mdhd`/`stsz`
 * give geometry, duration and frame count, and a y4m's one-line header gives all three. That matters
 * because the master's constraints — long enough to loop, large enough not to upscale, the right shape —
 * have to be enforced *before* four `veryslow` encodes, and because the job must be able to say whether
 * its input was the stand-in without asking anything outside the buffer it was handed.
 */
export function describeMaster(bytes: Uint8Array, extension: string): MasterDescription {
  const clean = extension.replace(/^\./, '').toLowerCase()
  const y4m = readY4mHeader(bytes)
  if (y4m !== undefined) {
    const frameBytes = (y4m.width * y4m.height * 3) / 2
    // `FRAME\n` per frame, plus the header line. Counting from the byte length rather than scanning for
    // the marker: a scan would find `FRAME` inside a plane and over-count.
    const headerLength = bytes.indexOf(0x0a) + 1
    const frames = Math.max(0, Math.floor((bytes.length - headerLength) / (frameBytes + 6)))
    const seconds = y4m.frameRate === 0 ? 0 : frames / y4m.frameRate
    return {
      mimeType: 'video/x-yuv4mpegpipe',
      byteLength: bytes.length,
      width: y4m.width,
      height: y4m.height,
      durationSeconds: seconds,
      frameRate: y4m.frameRate,
      standIn: y4m.extensions.some((extra) => extra.includes(STAND_IN_MARKER)),
      extension: clean,
      duration: { timescale: y4m.frameRate, units: frames, seconds },
    }
  }

  // The box parser throws on a size that runs past the end, which is what arbitrary bytes look like to it.
  // A master that is simply not a video has to arrive as `[video-master-unreadable]` rather than as a
  // finding about box 'a vi' — the second sends the reader looking for a muxer bug.
  let track: ReturnType<typeof readTrackSummary>
  let movie: Mp4Duration | undefined
  try {
    track = readTrackSummary(bytes)
    movie = readDuration(bytes)
  } catch {
    track = undefined
    movie = undefined
  }
  if (track === undefined || movie === undefined) {
    throw new AppError(
      'validation',
      `[video-master-unreadable] the master is neither a YUV4MPEG2 stream nor an MP4 with a readable ` +
        'track header, so nothing can say how long it is or what shape it is',
      { details: { extension: clean, bytes: bytes.length } },
    )
  }
  return {
    mimeType: clean === 'mov' ? 'video/quicktime' : 'video/mp4',
    byteLength: bytes.length,
    width: track.width,
    height: track.height,
    durationSeconds: track.durationSeconds,
    frameRate: track.frameRate,
    standIn: Buffer.from(bytes.subarray(0, 512)).includes(STAND_IN_MARKER),
    extension: clean,
    duration: movie,
  }
}

/** Puts a video master into the private bucket. Never the public one — docs/08 §6. */
export async function storeVideoMaster(input: {
  readonly mediaId: string
  readonly extension: string
  readonly master: Uint8Array
  readonly storage: MediaStorage
}): Promise<string> {
  const key = videoMasterKey(input.mediaId, input.extension)
  const description = describeMaster(input.master, input.extension)
  await input.storage.put({
    bucket: 'private',
    key,
    body: input.master,
    contentType: description.mimeType,
    cacheControl: PRIVATE_CACHE_CONTROL,
  })
  return key
}

export interface VideoRenditionOutput {
  readonly path: string
  readonly crop: VideoRendition['crop']
  readonly codec: VideoCodec
  readonly bytes: number
  readonly sha256: string
  /** True when the object was already in the bucket and nothing was encoded for it. */
  readonly reused: boolean
  /** Read out of the stored bytes, not out of the argv. Undefined only for a reused object. */
  readonly codecTag?: string
  readonly faststart?: boolean
  readonly durationSeconds?: number
  readonly withinBudget: boolean
}

export interface BuildVideoRenditionsInput {
  readonly mediaId: string
  readonly slot: string
  readonly master: Uint8Array
  readonly masterExtension: string
  readonly focal?: FocalPercent
  readonly storage: MediaStorage
  readonly encoder: VideoEncoder
}

export interface VideoBuildResult {
  readonly mediaId: string
  readonly slot: MediaSlotName
  readonly contentHash: string
  readonly master: MasterDescription
  readonly outputs: readonly VideoRenditionOutput[]
  readonly encoded: number
  readonly reused: number
  readonly encoder: string
  /** Every rendition over docs/08 §8's per-crop budget, phrased with the measured number. */
  readonly overBudget: readonly string[]
}

/** The centre of the frame, which is what no declared focal point means. */
export const CENTRE_FOCAL: FocalPercent = { x: 50, y: 50 }

/**
 * The only slot a hero video belongs to.
 *
 * A list of one, and a named refusal for anything else, rather than accepting whatever the job data says.
 * W-SYS-09's registry has six slots and five of them are photographs on cards; producing a 1920×1080
 * ping-pong loop for a wordmark is not a thing to do quietly.
 */
export function assertVideoSlot(slot: string): MediaSlotName {
  const known = mediaSlot(slot)
  if (known.name !== HERO_VIDEO_SLOT) {
    throw new AppError(
      'validation',
      `[slot-has-no-video] slot '${slot}' is a still-image slot; only '${HERO_VIDEO_SLOT}' has a video ` +
        'rendition ladder. The slot registry is not widened to accept a master — a video is a different ' +
        'object with a different pipeline, a different byte cap and a different set of mime types.',
      { details: { slot } },
    )
  }
  return known.name
}

/**
 * The four renditions for one master: content-addressed, idempotent, probed, and capped.
 *
 * The encoder is an argument rather than constructed here. That is what lets the orchestration — the head
 * check that makes a second run free, the probe that reads the stored bytes back, the hard stop, the bucket
 * and the headers — be exercised without a two-hour encode, and it is why `resolveFfmpeg` is the only path
 * to the real one: there is no default that could silently be something else.
 */
export async function buildVideoRenditions(
  input: BuildVideoRenditionsInput,
): Promise<VideoBuildResult> {
  const slot = assertVideoSlot(input.slot)
  const contentHash = contentAddress(input.master)
  const focal = input.focal ?? CENTRE_FOCAL
  const master = describeMaster(input.master, input.masterExtension)
  // Before any encode. Four `veryslow` passes is an hour; discovering then that the master was 1280 wide
  // is an hour spent producing four upscaled files.
  assertMasterAcceptable(master)

  const source: SourceGeometry = { width: master.width, height: master.height }
  const outputs: VideoRenditionOutput[] = []
  const overBudget: string[] = []

  for (const rendition of VIDEO_RENDITIONS) {
    const path = videoRenditionPath({
      mediaId: input.mediaId,
      contentHash,
      slot,
      crop: rendition.crop,
      codec: rendition.codec,
    })
    const key = publicKeyFor(path)

    const existing = await input.storage.head({ bucket: 'public', key })
    if (existing !== undefined) {
      const weight = { crop: rendition.crop, codec: rendition.codec, bytes: existing.bytes }
      assertWithinHardStop(weight)
      if (!isWithinBudget(weight)) overBudget.push(overBudgetMessage(weight))
      outputs.push({
        path,
        crop: rendition.crop,
        codec: rendition.codec,
        bytes: existing.bytes,
        sha256: existing.sha256,
        reused: true,
        withinBudget: isWithinBudget(weight),
      })
      continue
    }

    const body = await input.encoder.encode({
      rendition,
      master: input.master,
      masterExtension: master.extension,
      source,
      focal,
    })

    const label = `${rendition.crop}/${rendition.codec}`
    const probe = probeMp4(body)
    // Read back out of the bytes that are about to be stored, in this order: a file with no index is not
    // a file whose codec tag is worth reading.
    assertFaststart(body, label)
    assertCodecTag(body, REQUIRED_CODEC_TAG[rendition.codec], label)
    if (probe.duration !== undefined && master.frameRate > 0) {
      assertPingPongDuration({
        master: master.duration,
        rendition: probe.duration,
        frameRate: master.frameRate,
        label,
      })
    }
    const weight = { crop: rendition.crop, codec: rendition.codec, bytes: body.length }
    assertWithinHardStop(weight)
    if (!isWithinBudget(weight)) overBudget.push(overBudgetMessage(weight))

    const stored = await input.storage.put({
      bucket: 'public',
      key,
      body,
      contentType: VIDEO_CONTENT_TYPE,
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    })
    outputs.push({
      path,
      crop: rendition.crop,
      codec: rendition.codec,
      bytes: stored.bytes,
      sha256: sha256Hex(body),
      reused: false,
      ...(probe.codecTag === undefined ? {} : { codecTag: probe.codecTag }),
      faststart: probe.faststart,
      ...(probe.duration === undefined ? {} : { durationSeconds: probe.duration.seconds }),
      withinBudget: isWithinBudget(weight),
    })
  }

  if (outputs.length !== VIDEO_RENDITIONS.length) {
    throw new AppError(
      'invariant_violated',
      `[video-rendition-count-mismatch] produced ${outputs.length} renditions and the ladder declares ` +
        `${VIDEO_RENDITIONS.length}`,
      { details: { produced: outputs.length, expected: VIDEO_RENDITIONS.length } },
    )
  }

  // The listing assertion, made by the job rather than only by a test: docs/08 §6 says "Skip VP9/WebM
  // entirely" and "No HLS, no hls.js", and the way that stops being true is a fifth rendition arriving
  // with its own argv. What is in the bucket under this content address is the fact.
  const prefix = `m/${input.mediaId}/${contentHash}/`
  const present = (await input.storage.list('public')).filter((key) => key.startsWith(prefix))
  const expected = new Set(outputs.map((output) => publicKeyFor(output.path)))
  const unexpected = present.filter((key) => !expected.has(key))
  if (unexpected.length > 0) {
    throw new AppError(
      'invariant_violated',
      `[unexpected-video-output] ${unexpected.join(', ')} is under this master's content address and is ` +
        'not one of the four declared renditions. docs/08 §6 permits H.264 and HEVC in MP4 and nothing ' +
        `else — no ${FORBIDDEN_CONTAINERS.join(', no ')}.`,
      { details: { unexpected, expected: [...expected] } },
    )
  }

  return {
    mediaId: input.mediaId,
    slot,
    contentHash,
    master,
    outputs,
    encoded: input.encoder.count(),
    reused: outputs.filter((output) => output.reused).length,
    encoder: input.encoder.describe,
    overBudget,
  }
}

/** Re-exported so a caller that has the encoder does not also have to import the ladder for a prefix. */
export { PRIVATE_VIDEO_MASTER_PREFIX }
