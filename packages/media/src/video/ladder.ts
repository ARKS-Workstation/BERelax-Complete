/**
 * The hero video ladder: four renditions, the flags that produce them, their paths and their caps.
 *
 * Pure. No `sharp`, no `node:*`, no I/O — the same discipline as `ladders.ts`, and for the same reason:
 * W-SYS-07's attach island runs in a browser and has to build the `<source>` list from the *same*
 * declaration the worker encoded against. A rendition the island asks for and the job never produced is
 * a 404 behind a `<video>` element, which the browser resolves by showing the poster forever and
 * reporting nothing.
 *
 * ## Four files, and why not five
 *
 * docs/08 §6: "Two renditions per crop: H.264 High (universal) + HEVC `hvc1` (Safari). Skip VP9/WebM
 * entirely." Two crops (art-directed, not CSS-cropped) × two codecs = four. **No VP9, no AV1 at MVP, no
 * HLS.** Each of those is a real cost with no buyer here: VP9 duplicates H.264's coverage on the only
 * browsers that lack HEVC, AV1 is docs/08 §8's first cut when a page exceeds budget, and HLS for a
 * six-second muted loop adds a manifest, a segment list and 30KB of hls.js to replace a Range request
 * the browser already makes. `FORBIDDEN_CONTAINERS` is what keeps that a checkable fact.
 *
 * ## Where the two geometries come from
 *
 * The acceptance fixes `-level 4.0` on desktop and `-level 3.1` on mobile, and an H.264 level is, among
 * other things, a cap on macroblocks per frame (`MAX_MACROBLOCKS`).
 *
 * **Desktop is the level.** Level 4.0 allows 8192 macroblocks and 1920×1080 is 8160 — they are a matched
 * pair, which is why 1080p and level 4.0 are always quoted together.
 *
 * **Mobile is the budget, inside the level.** Level 3.1 allows 3600, and the mobile *image* ladder's widest
 * rung — 1080×1350 at 4:5 — is 5780, so the declared level already rules the image ladder's top rung out as
 * a video frame. What sets the actual number is docs/08 §8's 350KB: a ping-pong of a three-second master is
 * about six and a half seconds, so 350KB is roughly 440 kbit/s, and at 720×900×25 that is already 0.027
 * bits per pixel. A larger frame inside the same level spends the same bytes on more pixels and looks
 * softer, which on a slow ambient loop is the one thing a viewer would notice.
 *
 * `ladder.test.ts` asserts all three facts — both renditions fit their levels, desktop fills 4.0, and the
 * image ladder's widest mobile rung does not fit 3.1 — so a resolution raised without raising the level
 * fails here rather than producing a file a phone decoder refuses to open.
 *
 * ## What the CRF numbers are, and which one is provisional
 *
 * docs/08 §6 states the H.264 pair exactly: `-crf 26` desktop, `-crf 28` mobile. It states **no** CRF for
 * HEVC. x265's CRF scale is not x264's — the same number yields a smaller, softer file — so reusing 26/28
 * for HEVC is deliberately the conservative direction against the byte budget rather than a quality
 * decision, and it is recorded as `Y12-hero-video` in docs/OPEN-QUESTIONS.md. It cannot be tuned until
 * there is footage to measure, and `pnpm budgets` is what will notice when it is.
 */
import { AppError } from '@berelax/shared'
import { CROPS, type CropName, cropRectFor } from '../ladders.ts'
import { type MediaSlotName, mediaSlot, SLOT_RATIO_TOLERANCE } from '../slots/registry.ts'
import { assertContentHash, assertMediaId } from '../url.ts'

const KIB = 1024
const MIB = 1024 * 1024

/**
 * The two video codecs, and the tag each one is written with.
 *
 * `hvc1` is not cosmetic. An HEVC track tagged `hev1` is legal ISO BMFF and Safari ignores it — the
 * element reports no error, fires no `playing`, and the poster simply stays. docs/08 §6 marks the tag
 * "mandatory or Safari ignores it", and `probe.ts` reads it back out of the stored bytes rather than
 * trusting that the flag was passed.
 */
export type VideoCodec = 'h264' | 'hevc'

export const VIDEO_CODECS: readonly VideoCodec[] = ['h264', 'hevc']

/** The `stsd` sample-entry 4cc each codec must be written with. */
export const REQUIRED_CODEC_TAG: Readonly<Record<VideoCodec, string>> = {
  h264: 'avc1',
  hevc: 'hvc1',
}

/** The ffmpeg encoder each codec is produced by. Named so a fallback encoder cannot be silent. */
export const CODEC_ENCODER: Readonly<Record<VideoCodec, string>> = {
  h264: 'libx264',
  hevc: 'libx265',
}

/** The one container. A directory listing assertion is only meaningful against a closed list. */
export const VIDEO_CONTAINER = 'mp4'
export const VIDEO_CONTENT_TYPE = 'video/mp4'

/**
 * Containers this pipeline must never produce, as extensions.
 *
 * Asserted by listing the bucket rather than by reading the argv, because the failure being prevented is
 * "somebody added a fifth rendition", and a fifth rendition would come with its own argv.
 */
export const FORBIDDEN_CONTAINERS: readonly string[] = ['webm', 'm3u8', 'mpd', 'ts', 'm4s']

/** Macroblocks per frame each H.264 level admits. The source of both geometries below. */
export const MAX_MACROBLOCKS: Readonly<Record<string, number>> = { '3.1': 3600, '4.0': 8192 }

export interface VideoRendition {
  readonly crop: CropName
  readonly codec: VideoCodec
  /** Encoded frame width. A multiple of 16, so no level is exceeded by macroblock padding. */
  readonly width: number
  readonly height: number
  /** The H.264 level, and the HEVC tier ceiling the same geometry is encoded under. */
  readonly level: string
  /** H.264 profile. `high` is docs/08 §6's; 8-bit, which `-pix_fmt yuv420p` pins. */
  readonly profile: string
  readonly crf: number
}

/**
 * The four renditions, in the order a `<video>` lists its sources: HEVC first, then H.264.
 *
 * Order matters in the element, not here — but declaring it here means the island cannot invent one.
 * Safari picks the first source it can play, so HEVC before H.264 is what gets a Mac the smaller file;
 * every other browser falls through to H.264 because it reports `hvc1` unplayable.
 */
export const VIDEO_RENDITIONS: readonly VideoRendition[] = [
  {
    crop: 'desktop',
    codec: 'hevc',
    width: 1920,
    height: 1080,
    level: '4.0',
    profile: 'main',
    crf: 26,
  },
  {
    crop: 'desktop',
    codec: 'h264',
    width: 1920,
    height: 1080,
    level: '4.0',
    profile: 'high',
    crf: 26,
  },
  {
    crop: 'mobile',
    codec: 'hevc',
    width: 720,
    height: 900,
    level: '3.1',
    profile: 'main',
    crf: 28,
  },
  {
    crop: 'mobile',
    codec: 'h264',
    width: 720,
    height: 900,
    level: '3.1',
    profile: 'high',
    crf: 28,
  },
]

/**
 * docs/08 §8's hero-video budgets, per crop.
 *
 * Per **rendition**, not per crop total: a client downloads exactly one of the two codecs, so the number
 * that matters is the weight of the single file it gets. `build/budgets.json` mirrors these and
 * `scripts/check-budgets.mjs` fails if the two disagree — one number, two readers.
 */
export const VIDEO_BUDGET_BYTES: Readonly<Record<CropName, number>> = {
  mobile: 350 * KIB,
  desktop: Math.round(1.2 * MIB),
}

/**
 * The hard stop. docs/08 §8 writes it as "≤1.2MB — hard stop 2MB", and the two are different powers.
 *
 * The budget is a **CI** failure with the measured number (docs/08 §8's second enforcement layer); the
 * hard stop is the job refusing to publish at all. Keeping them apart is what makes each reachable: if
 * the job refused at the budget, no rendition could ever reach 2MB and the hard stop would be a rule
 * that has never been able to fire — ADR 0003's failure mode with a byte count attached. docs/08 §8's
 * cut order is the documented route back under budget, and it is a design decision, not a gate.
 */
export const VIDEO_HARD_STOP_BYTES = 2 * MIB

/**
 * The longest master this pipeline will ping-pong, in seconds.
 *
 * `reverse` is not a streaming filter: it buffers every decoded frame of its input before it emits the
 * first one. At 1920×1080 yuv420p that is 3.1MB per frame, so a 6-second 25fps master costs about
 * 470MB of resident memory inside ffmpeg — on top of two x265 encodes. docs/08 §8's cut order already
 * shortens the loop to 4 seconds and ping-pongs it, so the ceiling here is generous rather than tight,
 * and a master over it is refused by name instead of being killed by the OOM killer halfway through
 * rendition three, which looks exactly like a flaky job.
 */
export const MAX_MASTER_SECONDS = 8

/**
 * The private-bucket prefix video masters live under.
 *
 * A separate prefix from `originals`, because a master is not an original: nothing resizes it, the
 * derivative job must never be handed one, and `scripts/check-media.mjs` guards both prefixes against
 * ever appearing in a URL. docs/08 §6 puts "originals, video masters, signed consent PDFs" in the same
 * private bucket, and gives them no CDN and no public read.
 */
export const PRIVATE_VIDEO_MASTER_PREFIX = 'video-masters'

/**
 * The mime types a master may arrive as.
 *
 * MP4 and QuickTime are what a camera or an editor delivers. `video/x-yuv4mpegpipe` is here because the
 * stand-in master this unit ships is a y4m — there is no hero footage (`Y12-hero-video`) — and a container
 * the pipeline accepts in a test and refuses in production would make the test prove nothing about
 * production. It is uncompressed, so nothing would ever upload one by accident.
 */
export const VIDEO_MASTER_MIME_TYPES: readonly string[] = [
  'video/mp4',
  'video/quicktime',
  'video/x-yuv4mpegpipe',
]

/** The file extensions those mime types arrive as, so a key can be built from a mime type and back. */
export const MASTER_EXTENSIONS: Readonly<Record<string, string>> = {
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/x-yuv4mpegpipe': 'y4m',
}

/**
 * The largest master the private bucket will take, **per container**.
 *
 * Six seconds of ProRes 422 at 1080p25 is about 90MB, which is the shape a photographer actually delivers,
 * so 128MiB admits that and refuses a 4K camera original nobody asked for. Deliberately **not** the hero
 * slot's 8MiB image cap: that number is about AVIF encode cost per megapixel and a stray full-resolution
 * photograph of a member of staff, and neither applies to a video master.
 *
 * It is per container because one number for both is wrong by an order of magnitude, which a test found
 * rather than a review: a y4m is uncompressed, 3.11MB per 1080p frame, so the same three seconds of footage
 * is 233MB as a y4m and about 20MB as an MP4. A single 128MiB cap refused this unit's own stand-in master.
 * The cap that really bounds the work is `MAX_MASTER_SECONDS`, because the memory cost is the ping-pong
 * filter's frame buffer and that is a function of duration and geometry, not of how the input was coded.
 */
export const MAX_MASTER_BYTES: Readonly<Record<string, number>> = {
  'video/mp4': 128 * MIB,
  'video/quicktime': 128 * MIB,
  'video/x-yuv4mpegpipe': 256 * MIB,
}

/** The cap for a container, falling back to the tightest so an unknown one is never the loosest. */
export function maxMasterBytes(mimeType: string): number {
  return MAX_MASTER_BYTES[mimeType] ?? Math.min(...Object.values(MAX_MASTER_BYTES))
}

/**
 * The slot the hero video belongs to, and everything about how the two relate.
 *
 * **A video is not an image, and the image slot was not widened to take one.** `mediaSlot('hero')`
 * declares `mimeTypes: ['image/jpeg', 'image/png']` and an 8MiB cap, and `validateUpload` refuses a
 * `video/mp4` there by name (`slot-mime-not-allowed`) — which is correct and must stay correct, because
 * every other consumer of that descriptor is an image path: the AVIF ladder, the OKLCH placeholder, the
 * `aspect-ratio` a card reserves, the alt-text filter. Adding `video/mp4` to it would make a master
 * eligible for twenty-four `sharp` encodes that would fail somewhere inside libvips.
 *
 * What the two **do** share is the thing that has to agree: the frame. The desktop rendition is the
 * hero slot's declared 16:9, the mobile rendition is the mobile crop's 4:5, both read from
 * `CROPS`/`SLOT_REGISTRY` rather than restated — so the video and the poster behind it are the same two
 * shapes, and `HeroMedia`'s `<picture>` and `<video>` cannot art-direct differently.
 */
export const HERO_VIDEO_SLOT: MediaSlotName = 'hero'

export interface HeroVideoRelation {
  readonly slot: MediaSlotName
  /** The ratio each crop is taken at, read from the image ladders. */
  readonly ratios: Readonly<Record<CropName, number>>
  /** True when the slot's own upload rules reject a video master, which they must. */
  readonly slotAcceptsVideo: boolean
}

/** How the hero video relates to the hero image slot. Asserted, not described. */
export function heroVideoRelation(): HeroVideoRelation {
  const slot = mediaSlot(HERO_VIDEO_SLOT)
  return {
    slot: slot.name,
    ratios: {
      mobile: CROPS.mobile.ratio[0] / CROPS.mobile.ratio[1],
      desktop: CROPS.desktop.ratio[0] / CROPS.desktop.ratio[1],
    },
    slotAcceptsVideo: VIDEO_MASTER_MIME_TYPES.some((mime) =>
      (slot.mimeTypes as readonly string[]).includes(mime),
    ),
  }
}

/** The private-bucket key for a video master. Never reachable from a URL. */
export function videoMasterKey(mediaId: string, extension: string): string {
  assertMediaId(mediaId)
  const clean = extension.replace(/^\./, '').toLowerCase()
  return `${PRIVATE_VIDEO_MASTER_PREFIX}/${mediaId}.${clean}`
}

/** Whether a private-bucket key is a video master of ours. The job refuses anything else. */
export function isVideoMasterKey(key: string): boolean {
  return key.startsWith(`${PRIVATE_VIDEO_MASTER_PREFIX}/`)
}

/**
 * The pattern every video rendition path matches.
 *
 * Deliberately disjoint from `DERIVATIVE_PATH_PATTERN`, which ends `(avif|webp|jpg)`: the two live in
 * the same `/m/{mediaId}/{hash}/` directory and must never be mistaken for one another, because the
 * image loader parses one of them and would otherwise be handed an `.mp4` to pick a rung for.
 */
export const VIDEO_RENDITION_PATH_PATTERN =
  /^\/m\/[0-9a-f-]{36}\/[0-9a-f]{16}\/[a-z0-9-]+-video-(mobile|desktop)-(h264|hevc)\.mp4$/

export interface VideoRenditionRef {
  readonly mediaId: string
  readonly contentHash: string
  readonly slot: MediaSlotName
  readonly crop: CropName
  readonly codec: VideoCodec
}

/**
 * The immutable public path for one rendition.
 *
 * Content-addressed on the **master's** bytes, exactly as the image derivatives are on the original's:
 * re-grade the footage and every rendition lands on a new path, so a year of `immutable` needs no purge
 * and a `?v=` query string — which a proportion of intermediary caches drop from their cache key — is
 * never needed.
 */
export function videoRenditionPath(ref: VideoRenditionRef): string {
  assertMediaId(ref.mediaId)
  assertContentHash(ref.contentHash)
  const name = `${ref.slot}-video-${ref.crop}-${ref.codec}.${VIDEO_CONTAINER}`
  const path = `/m/${ref.mediaId}/${ref.contentHash}/${name}`
  if (!VIDEO_RENDITION_PATH_PATTERN.test(path)) {
    // Unreachable through the assertions above, which is why it is here: the pattern is the contract
    // W-SYS-07 matches against, and a path this function built that fails it must stop the job rather
    // than reach a `<source src>`.
    throw new AppError(
      'invariant_violated',
      `[video-path-off-pattern] '${path}' does not match the declared video rendition URL pattern`,
      { details: { path } },
    )
  }
  return path
}

/** The four paths one master expands into, in declaration order. */
export function videoRenditionPaths(input: {
  readonly mediaId: string
  readonly contentHash: string
  readonly slot: MediaSlotName
}): readonly string[] {
  return VIDEO_RENDITIONS.map((rendition) =>
    videoRenditionPath({ ...input, crop: rendition.crop, codec: rendition.codec }),
  )
}

/** The `profile_idc` of each H.264 profile this pipeline encodes. High is 100, which is 0x64. */
export const H264_PROFILE_IDC: Readonly<Record<string, number>> = { high: 100 }

/**
 * The `codecs` parameter each codec's `<source type>` carries, derived from the rendition.
 *
 * **H.264 is stated exactly.** `avc1.PPCCLL` is three bytes of hex: the profile_idc, the constraint set
 * flags and the level_idc. High is 100 (0x64) and level 4.0 is 40 (0x28), so the desktop rendition is
 * `avc1.640028` and the mobile one, at level 3.1, is `avc1.64001f`. Every digit is a number this module
 * already declares, so the string is computed from `profile` and `level` rather than written down: a
 * `codecs` parameter that disagrees with the file is worse than none, because the browser believes it.
 *
 * **HEVC is the 4CC alone**, and that is the decision rather than an omission. A full HEVC codecs string is
 * `hvc1.A.B.LX.C…` — general profile space, profile compatibility flags, tier, level and up to six
 * constraint bytes — and four of those are chosen by x265 at encode time and readable only out of the
 * written file's `hvcC` box. Declaring them here would mean declaring what they are *likely* to be, and an
 * over-specific string that is wrong makes Safari skip the track silently: the element reports no error,
 * fires no `playing`, and the poster simply stays. That is the same failure the `hev1`/`hvc1` tag confusion
 * causes, and docs/08 §6 marks it "mandatory or Safari ignores it". `hvc1` on its own is a valid codecs
 * parameter, is what Safari matches on, and is exactly as much as this declaration actually knows.
 * `probe.ts` reads the real sample-entry 4cc back out of the stored bytes and refuses a mismatch.
 */
export function videoSourceType(rendition: VideoRendition): string {
  if (rendition.codec !== 'h264') {
    return `${VIDEO_CONTENT_TYPE}; codecs="${REQUIRED_CODEC_TAG[rendition.codec]}"`
  }
  const profileIdc = H264_PROFILE_IDC[rendition.profile]
  if (profileIdc === undefined) {
    throw new AppError(
      'invariant_violated',
      `[h264-profile-has-no-idc] '${rendition.profile}' is not a profile this module can write a codecs ` +
        'parameter for. A `<source type>` that names the wrong profile is believed by the browser.',
      { details: { profile: rendition.profile, known: Object.keys(H264_PROFILE_IDC) } },
    )
  }
  const levelIdc = Math.round(Number.parseFloat(rendition.level) * 10)
  const hex = (value: number): string => value.toString(16).padStart(2, '0')
  return `${VIDEO_CONTENT_TYPE}; codecs="avc1.${hex(profileIdc)}00${hex(levelIdc)}"`
}

/** One `<source>` the hero's `<video>` may be given. */
export interface HeroVideoSource {
  readonly crop: CropName
  readonly codec: VideoCodec
  readonly src: string
  readonly type: string
  /**
   * The crop's media query, from `CROPS`.
   *
   * It is **not** the `media` attribute of a `<source>`: that attribute does nothing inside a `<video>` —
   * it is honoured for `<picture>` and was removed from the video element's resource selection algorithm.
   * So an art-directed video has to evaluate the query itself, and W-SYS-07's island does, with
   * `matchMedia`. Carrying the ladder's own string is what stops the breakpoint being written twice.
   */
  readonly media: string
}

/**
 * The `<source>` list for one master, in the order a `<video>` should list them.
 *
 * HEVC before H.264 within each crop, which is what gets a Mac the smaller file: Safari takes the first
 * source it can play and every other browser falls through, because it reports `hvc1` unplayable. The order
 * is `VIDEO_RENDITIONS`' own, so the element cannot list them in an order this pipeline did not declare.
 *
 * Both crops are returned. Which one a viewport is served is a question only the browser can answer, and
 * answering it here would mean the server guessing a viewport — the mistake that makes a prerendered page
 * serve the phone's crop to a laptop.
 */
export function heroVideoSources(input: {
  readonly mediaId: string
  readonly contentHash: string
  readonly slot?: MediaSlotName
}): readonly HeroVideoSource[] {
  const slot = input.slot ?? HERO_VIDEO_SLOT
  return VIDEO_RENDITIONS.map((rendition) => ({
    crop: rendition.crop,
    codec: rendition.codec,
    src: videoRenditionPath({
      mediaId: input.mediaId,
      contentHash: input.contentHash,
      slot,
      crop: rendition.crop,
      codec: rendition.codec,
    }),
    type: videoSourceType(rendition),
    media: CROPS[rendition.crop].media,
  }))
}

/**
 * Whether the declared geometries fit inside their declared levels.
 *
 * Exported because it is the derivation, not a formality: `ladder.test.ts` runs it over the four
 * renditions and over a deliberately oversized one, so raising a resolution without raising the level
 * fails here rather than producing a file a phone decoder refuses to open.
 */
export function macroblocksFor(rendition: Pick<VideoRendition, 'width' | 'height'>): number {
  return Math.ceil(rendition.width / 16) * Math.ceil(rendition.height / 16)
}

export function fitsItsLevel(rendition: VideoRendition): boolean {
  const ceiling = MAX_MACROBLOCKS[rendition.level]
  return ceiling !== undefined && macroblocksFor(rendition) <= ceiling
}

/**
 * The seamless ping-pong graph, exactly as docs/08 §6 writes it.
 *
 * `[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1[out]`
 *
 * Two properties of it are worth stating because a test depends on each. The output is 2N frames for an
 * N-frame input, so its duration is exactly twice the master's — the acceptance's "±1 frame" is what
 * absorbs a timescale rounding, not a frame this graph drops. And the **last** output frame is the
 * master's first frame, which is why the loop is seamless at the wrap point: `<video loop>` cuts from
 * the last frame back to the first, and here those are the same picture.
 *
 * The cost of docs/08's spelling is that frame N appears twice at the turn — one held frame, 40ms at
 * 25fps. `trim=start_frame=1` on the reversed leg would remove it and make the output 2N−1 frames, at
 * which point the duration is no longer twice the source. docs/08 chose the duplicate; it is invisible
 * on a slow ambient loop and the doubled duration is what the acceptance asserts, so it stays.
 */
export const PING_PONG_FILTER = '[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1[out]'

export interface SourceGeometry {
  readonly width: number
  readonly height: number
}

export interface FocalPercent {
  readonly x: number
  readonly y: number
}

/**
 * The filter chain for one rendition: crop, scale, pin the pixel format, then ping-pong.
 *
 * **Crop and scale before `split`/`reverse`, not after.** Functionally either order produces the same
 * pixels; the difference is that `reverse` buffers whatever reaches it, so reversing 1920×1080 frames to
 * produce a 720×900 rendition costs four times the memory of reversing the 720×900 frames — for the same
 * output. It is the same reasoning as cropping before resizing in the image pipeline, one resource down.
 *
 * `format=yuv420p` is pinned rather than left to the encoder. A 10-bit master handed to x264 produces
 * High 10, which is a legal H.264 profile that no iPhone and no Safari can decode in hardware; the
 * symptom is a hero that plays on the developer's laptop and shows the poster on every phone.
 */
export function filterGraphFor(
  rendition: VideoRendition,
  source: SourceGeometry,
  focal: FocalPercent,
): string {
  const rect = cropRectFor(source, rendition.crop, focal)
  const crop = `crop=${rect.width}:${rect.height}:${rect.left}:${rect.top}`
  const scale = `scale=${rendition.width}:${rendition.height}:flags=lanczos`
  return `[0:v]${crop},${scale},format=yuv420p,split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1[out]`
}

export interface ArgvInput {
  readonly rendition: VideoRendition
  readonly inputPath: string
  readonly outputPath: string
  readonly source: SourceGeometry
  readonly focal: FocalPercent
}

/**
 * The exact ffmpeg argv for one rendition.
 *
 * A pure function returning an array, and never a shell string. Two reasons, and the second is the one
 * that matters: an array goes to `execFile` with no shell, so a filename cannot become an argument; and
 * an argv that is a value can be asserted flag by flag, which is how `ladder.test.ts` proves
 * `-profile:v high -level 4.0 -crf 26` reaches the encoder rather than proving that a string containing
 * those characters was composed.
 */
export function ffmpegArgv(input: ArgvInput): readonly string[] {
  const { rendition } = input
  const argv = [
    // `-nostdin` because a job has no terminal: without it ffmpeg reads stdin for keypresses and an
    // inherited closed descriptor makes it exit immediately with no useful message.
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    // Overwrite. The output is a temporary file this process just named; a prompt would hang the job.
    '-y',
    '-i',
    input.inputPath,
    '-filter_complex',
    filterGraphFor(rendition, input.source, input.focal),
    '-map',
    '[out]',
    // No audio track at all. docs/08 §6: "Never autoplay with sound. Ever." A muted track is still
    // bytes, still a decoder, and still something a future change can unmute.
    '-an',
    '-c:v',
    CODEC_ENCODER[rendition.codec],
    '-preset',
    // docs/08 §6 states `veryslow` for H.264 and states no preset for HEVC. The same value is used for
    // both rather than a second number nobody derived; the cost is real and is why this job's
    // `expireInSeconds` is an hour rather than ten minutes.
    'veryslow',
    '-crf',
    String(rendition.crf),
    '-pix_fmt',
    'yuv420p',
  ]
  if (rendition.codec === 'h264') {
    argv.push('-profile:v', rendition.profile, '-level', rendition.level)
  } else {
    // x265 takes the profile and the level through its own parameter list; `-level` on the ffmpeg side
    // is an H.264 option and is silently ignored here, which is the kind of flag that looks applied and
    // is not.
    argv.push(
      '-x265-params',
      `profile=${rendition.profile}:level-idc=${rendition.level.replace('.', '')}`,
    )
    // docs/08 §6: mandatory, or Safari ignores the track entirely.
    argv.push('-tag:v', 'hvc1')
  }
  argv.push(
    // Every MP4, per docs/08 §6. `probe.ts` verifies the box order it produces rather than trusting it.
    '-movflags',
    '+faststart',
    '-f',
    VIDEO_CONTAINER,
    input.outputPath,
  )
  return argv
}

/** Named refusals this module can raise about a master, so a caller can assert by rule. */
export const VIDEO_MASTER_RULES = [
  'video-master-mime-not-allowed',
  'video-master-over-maximum-bytes',
  'video-master-too-long-to-ping-pong',
  'video-master-below-minimum-dimensions',
  'video-master-ratio-out-of-tolerance',
] as const

export type VideoMasterRule = (typeof VIDEO_MASTER_RULES)[number]

export interface MasterMeasurement {
  readonly mimeType: string
  readonly byteLength: number
  readonly durationSeconds: number
  readonly width: number
  readonly height: number
}

export interface MasterViolation {
  readonly rule: VideoMasterRule
  readonly message: string
}

/**
 * The narrowest frame a master may be: the widest rendition's, because nothing here upscales.
 *
 * The image pipeline deliberately produces every declared rung even when the source is smaller, because
 * a missing rung inside a `srcset` is a 404 the browser resolves by showing nothing. A video has no
 * `srcset` and no fallback rung — there are four files and the element picks one — so an upscaled hero
 * loop is simply a soft hero loop, and refusing the master is the honest answer.
 */
export const MIN_MASTER_WIDTH = 1920
export const MIN_MASTER_HEIGHT = 1080

/** Every rule a master breaks, in declaration order. Empty means publishable. */
export function masterViolations(measurement: MasterMeasurement): readonly MasterViolation[] {
  const out: MasterViolation[] = []
  if (!VIDEO_MASTER_MIME_TYPES.includes(measurement.mimeType)) {
    out.push({
      rule: 'video-master-mime-not-allowed',
      message:
        `[video-master-mime-not-allowed] the hero video master is ${measurement.mimeType}; this ` +
        `pipeline accepts ${VIDEO_MASTER_MIME_TYPES.join(', ')}. The hero *image* slot accepts neither ` +
        'of those and is not widened to: a master is a different object with a different pipeline.',
    })
  }
  const byteCap = maxMasterBytes(measurement.mimeType)
  if (measurement.byteLength > byteCap) {
    out.push({
      rule: 'video-master-over-maximum-bytes',
      message:
        `[video-master-over-maximum-bytes] the master is ${measurement.byteLength} bytes against a cap ` +
        `of ${byteCap} for ${measurement.mimeType}`,
    })
  }
  if (measurement.durationSeconds > MAX_MASTER_SECONDS) {
    out.push({
      rule: 'video-master-too-long-to-ping-pong',
      message:
        `[video-master-too-long-to-ping-pong] the master runs ${measurement.durationSeconds}s and the ` +
        `ping-pong filter buffers every decoded frame; ${MAX_MASTER_SECONDS}s is the ceiling`,
    })
  }
  if (measurement.width < MIN_MASTER_WIDTH || measurement.height < MIN_MASTER_HEIGHT) {
    out.push({
      rule: 'video-master-below-minimum-dimensions',
      message:
        `[video-master-below-minimum-dimensions] the master is ${measurement.width}x${measurement.height} ` +
        `and the widest rendition is ${MIN_MASTER_WIDTH}x${MIN_MASTER_HEIGHT}; nothing here upscales`,
    })
  }
  const declared = CROPS.desktop.ratio[0] / CROPS.desktop.ratio[1]
  const actual = measurement.width / measurement.height
  if (Math.abs(actual - declared) / declared > SLOT_RATIO_TOLERANCE) {
    out.push({
      rule: 'video-master-ratio-out-of-tolerance',
      message:
        `[video-master-ratio-out-of-tolerance] the master is ${actual.toFixed(4)} and the desktop crop is ` +
        `${declared.toFixed(4)}; the 16:9 rendition is taken without cropping, so a master of another ` +
        'shape would be letterboxed or squeezed rather than art-directed',
    })
  }
  return out
}

export function assertMasterAcceptable(measurement: MasterMeasurement): void {
  const violations = masterViolations(measurement)
  const first = violations[0]
  if (first === undefined) return
  throw new AppError('validation', violations.map((violation) => violation.message).join('; '), {
    details: { rules: violations.map((violation) => violation.rule), measurement },
  })
}

export interface RenditionWeight {
  readonly crop: CropName
  readonly codec: VideoCodec
  readonly bytes: number
}

/**
 * The hard stop, and nothing else.
 *
 * The docs/08 §8 budget is enforced by `pnpm budgets` with the measured number, because that is the
 * layer docs/08 §8 puts it in and because two thresholds enforced at one point makes the higher one
 * unreachable. This is the threshold at which a rendition is broken rather than heavy: 2MB of deferred
 * video on a mid-tier 4G connection is most of a minute before the loop starts, and publishing it is
 * worse than publishing the still.
 */
export function assertWithinHardStop(weight: RenditionWeight): void {
  if (weight.bytes <= VIDEO_HARD_STOP_BYTES) return
  throw new AppError(
    'invariant_violated',
    `[video-rendition-over-hard-stop] ${weight.crop}/${weight.codec} measured ${weight.bytes} bytes ` +
      `against the ${VIDEO_HARD_STOP_BYTES}-byte hard stop in docs/08 §8. docs/08 §8's cut order is the ` +
      'route back under it — shorten the loop, then drop video on mobile, then drop it everywhere and ' +
      'animate the poster. Publishing this would spend the whole page budget on a decoration.',
    { details: { ...weight, hardStop: VIDEO_HARD_STOP_BYTES } },
  )
}

/** Whether a rendition is inside docs/08 §8's per-crop budget. Reported; `pnpm budgets` fails on it. */
export function isWithinBudget(weight: RenditionWeight): boolean {
  return weight.bytes <= VIDEO_BUDGET_BYTES[weight.crop]
}

/**
 * The per-crop budget breach, phrased with the measured number.
 *
 * One spelling, read by the job's log line and by `scripts/check-budgets.mjs`, so the number a developer
 * sees locally and the number CI fails with are produced by the same code.
 */
export function overBudgetMessage(weight: RenditionWeight): string {
  return (
    `[video-rendition-over-budget] ${weight.crop}/${weight.codec} measured ${weight.bytes} bytes ` +
    `against a budget of ${VIDEO_BUDGET_BYTES[weight.crop]} bytes`
  )
}
