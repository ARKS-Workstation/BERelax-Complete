import { describe, expect, it } from 'vitest'
import { CROPS } from '../ladders.ts'
import { mediaSlot } from '../slots/registry.ts'
import { validateUpload } from '../slots/validate.ts'
import { DERIVATIVE_PATH_PATTERN } from '../url.ts'
import {
  assertMasterAcceptable,
  assertWithinHardStop,
  CODEC_ENCODER,
  FORBIDDEN_CONTAINERS,
  ffmpegArgv,
  filterGraphFor,
  fitsItsLevel,
  HERO_VIDEO_SLOT,
  heroVideoRelation,
  isVideoMasterKey,
  isWithinBudget,
  MASTER_EXTENSIONS,
  MAX_MACROBLOCKS,
  MAX_MASTER_SECONDS,
  MIN_MASTER_HEIGHT,
  MIN_MASTER_WIDTH,
  macroblocksFor,
  masterViolations,
  maxMasterBytes,
  overBudgetMessage,
  PING_PONG_FILTER,
  REQUIRED_CODEC_TAG,
  VIDEO_BUDGET_BYTES,
  VIDEO_CONTAINER,
  VIDEO_HARD_STOP_BYTES,
  VIDEO_MASTER_MIME_TYPES,
  VIDEO_RENDITION_PATH_PATTERN,
  VIDEO_RENDITIONS,
  videoMasterKey,
  videoRenditionPath,
  videoRenditionPaths,
} from './ladder.ts'

const MEDIA_ID = '0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e1f'
const HASH = '0123456789abcdef'
const SOURCE = { width: 1920, height: 1080 }
const CENTRE = { x: 50, y: 50 }

/** A declared rendition by name. Throws rather than narrowing, so a renamed crop fails loudly. */
function rendition(crop: 'mobile' | 'desktop', codec: 'h264' | 'hevc') {
  const found = VIDEO_RENDITIONS.find((r) => r.crop === crop && r.codec === codec)
  if (found === undefined) throw new Error(`no ${crop}/${codec} rendition is declared`)
  return found
}

/** A master that breaks nothing, so every refusal below is one field away from a passing case. */
const GOOD_MASTER = {
  mimeType: 'video/mp4',
  byteLength: 20 * 1024 * 1024,
  durationSeconds: 3,
  width: 1920,
  height: 1080,
}

describe('the four renditions, and only four', () => {
  it('is exactly two crops by two codecs, with no duplicate', () => {
    expect(VIDEO_RENDITIONS).toHaveLength(4)
    const keys = VIDEO_RENDITIONS.map((r) => `${r.crop}/${r.codec}`)
    expect(new Set(keys).size).toBe(4)
    expect(new Set(VIDEO_RENDITIONS.map((r) => r.crop))).toEqual(new Set(['mobile', 'desktop']))
    expect(new Set(VIDEO_RENDITIONS.map((r) => r.codec))).toEqual(new Set(['h264', 'hevc']))
  })

  it('produces one container and names the ones docs/08 §6 forbids', () => {
    // The closed list is what makes a directory-listing assertion mean something. The control matters as
    // much as the rule: an empty forbidden list would make "zero .webm files" true of every repository.
    expect(FORBIDDEN_CONTAINERS.length).toBeGreaterThan(0)
    expect(FORBIDDEN_CONTAINERS).toContain('webm')
    expect(FORBIDDEN_CONTAINERS).toContain('m3u8')
    expect(FORBIDDEN_CONTAINERS).toContain('mpd')
    expect(FORBIDDEN_CONTAINERS).not.toContain(VIDEO_CONTAINER)
  })

  it('fits every geometry inside the level the acceptance declares', () => {
    for (const rendition of VIDEO_RENDITIONS) {
      expect(fitsItsLevel(rendition), `${rendition.crop}/${rendition.codec}`).toBe(true)
    }
    // Desktop and level 4.0 are a matched pair: 1920x1080 is 8160 of the 8192 macroblocks the level allows,
    // which is why the two are always quoted together.
    const ceiling40 = MAX_MACROBLOCKS['4.0'] as number
    expect(macroblocksFor({ width: 1920, height: 1080 })).toBeLessThanOrEqual(ceiling40)
    expect(macroblocksFor({ width: 1920, height: 1080 }) / ceiling40).toBeGreaterThan(0.95)

    // And the declared mobile level is what rules out the mobile *image* ladder's widest rung as a video
    // frame: 1080x1350 at 4:5 is 5780 macroblocks against level 3.1's 3600. So "why is the mobile video
    // smaller than the mobile poster" has an answer in the acceptance rather than in somebody's preference.
    expect(macroblocksFor({ width: 1080, height: 1350 })).toBeGreaterThan(
      MAX_MACROBLOCKS['3.1'] as number,
    )
    // The control: the same frame does not fit the tighter level, so `fitsItsLevel` is measuring something.
    expect(
      fitsItsLevel({ ...rendition('mobile', 'h264'), width: 1920, height: 1080, level: '3.1' }),
    ).toBe(false)
  })

  it('crops each rendition at its own declared ratio rather than squeezing one frame', () => {
    for (const rendition of VIDEO_RENDITIONS) {
      const [w, h] = CROPS[rendition.crop].ratio
      expect(rendition.width / rendition.height, `${rendition.crop}`).toBeCloseTo(w / h, 2)
    }
  })
})

describe('the ffmpeg argv', () => {
  const argvFor = (crop: 'mobile' | 'desktop', codec: 'h264' | 'hevc'): readonly string[] =>
    ffmpegArgv({
      rendition: rendition(crop, codec),
      inputPath: '/tmp/master.y4m',
      outputPath: '/tmp/out.mp4',
      source: SOURCE,
      focal: CENTRE,
    })

  /** A flag and its value as an adjacent pair, which is the only way ffmpeg reads them. */
  const hasPair = (argv: readonly string[], flag: string, value: string): boolean =>
    argv.some((token, index) => token === flag && argv[index + 1] === value)

  it('carries exactly the H.264 flags docs/08 §6 and the acceptance state', () => {
    const desktop = argvFor('desktop', 'h264')
    expect(hasPair(desktop, '-c:v', 'libx264')).toBe(true)
    expect(hasPair(desktop, '-profile:v', 'high')).toBe(true)
    expect(hasPair(desktop, '-level', '4.0')).toBe(true)
    expect(hasPair(desktop, '-crf', '26')).toBe(true)
    expect(hasPair(desktop, '-preset', 'veryslow')).toBe(true)

    const mobile = argvFor('mobile', 'h264')
    expect(hasPair(mobile, '-crf', '28')).toBe(true)
    expect(hasPair(mobile, '-level', '3.1')).toBe(true)
    // The control: the two renditions really do differ, so a test that read one would not pass for both.
    expect(hasPair(mobile, '-crf', '26')).toBe(false)
    expect(hasPair(desktop, '-level', '3.1')).toBe(false)
  })

  it('tags HEVC hvc1, because Safari ignores hev1 without saying so', () => {
    for (const crop of ['mobile', 'desktop'] as const) {
      const argv = argvFor(crop, 'hevc')
      expect(hasPair(argv, '-c:v', 'libx265')).toBe(true)
      expect(hasPair(argv, '-tag:v', 'hvc1')).toBe(true)
      expect(hasPair(argv, '-tag:v', 'hev1')).toBe(false)
    }
    // And the H.264 pair does not carry it: `-tag:v hvc1` on an AVC track would be a lie in the stsd.
    expect(argvFor('desktop', 'h264')).not.toContain('-tag:v')
    expect(REQUIRED_CODEC_TAG.h264).toBe('avc1')
    expect(REQUIRED_CODEC_TAG.hevc).toBe('hvc1')
  })

  it('always asks for faststart, mp4, no audio and 8-bit 4:2:0', () => {
    for (const rendition of VIDEO_RENDITIONS) {
      const argv = ffmpegArgv({
        rendition,
        inputPath: '/tmp/m.y4m',
        outputPath: '/tmp/o.mp4',
        source: SOURCE,
        focal: CENTRE,
      })
      expect(hasPair(argv, '-movflags', '+faststart'), `${rendition.codec}`).toBe(true)
      expect(hasPair(argv, '-f', 'mp4')).toBe(true)
      // docs/08 §6: "Never autoplay with sound. Ever." A muted track is still bytes and still unmutable.
      expect(argv).toContain('-an')
      // A 10-bit master handed to x264 produces High 10, which no iPhone decodes in hardware — a hero that
      // plays on a laptop and shows the poster on every phone.
      expect(hasPair(argv, '-pix_fmt', 'yuv420p')).toBe(true)
      expect(argv.at(-1)).toBe('/tmp/o.mp4')
    }
  })

  it('names no encoder or container docs/08 §6 rules out', () => {
    const everything = VIDEO_RENDITIONS.flatMap((rendition) =>
      ffmpegArgv({
        rendition,
        inputPath: '/tmp/m.y4m',
        outputPath: '/tmp/o.mp4',
        source: SOURCE,
        focal: CENTRE,
      }),
    ).join(' ')
    for (const banned of ['libvpx', 'libvpx-vp9', 'webm', 'hls', 'dash', 'libsvtav1', 'libaom']) {
      expect(everything, banned).not.toContain(banned)
    }
    // The control: the encoders that ARE declared appear, so the absence above is not an absence of argv.
    for (const encoder of Object.values(CODEC_ENCODER)) expect(everything).toContain(encoder)
  })

  it('is an argument vector, never a shell string', () => {
    // A path with a space has to survive as one token. `execFile` with an array is what guarantees it; a
    // shell string here would make a filename into two arguments and, worse, make one injectable.
    const argv = ffmpegArgv({
      rendition: rendition('desktop', 'hevc'),
      inputPath: '/tmp/a directory/master file.y4m',
      outputPath: '/tmp/out.mp4',
      source: SOURCE,
      focal: CENTRE,
    })
    expect(argv).toContain('/tmp/a directory/master file.y4m')
    expect(argv).toContain('-nostdin')
  })

  it('ping-pongs with the graph docs/08 §6 writes, after the crop and the scale', () => {
    expect(PING_PONG_FILTER).toBe('[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1[out]')
    const graph = filterGraphFor(rendition('mobile', 'hevc'), SOURCE, CENTRE)
    // Crop and scale before split/reverse: `reverse` buffers every decoded frame it is handed, so
    // reversing 1920x1080 to produce 720x900 costs four times the memory for the same output.
    expect(graph.indexOf('crop=')).toBeLessThan(graph.indexOf('split'))
    expect(graph.indexOf('scale=')).toBeLessThan(graph.indexOf('split'))
    expect(graph).toContain('split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1[out]')
    // The 4:5 crop of a 16:9 frame is a genuine crop, not a squeeze: 1080 tall means 864 wide at 4:5.
    expect(graph).toContain('crop=864:1080')
    expect(graph).toContain('scale=720:900')
  })
})

describe('the rendition paths', () => {
  it('are content-addressed, immutable and disjoint from the image derivative pattern', () => {
    const path = videoRenditionPath({
      mediaId: MEDIA_ID,
      contentHash: HASH,
      slot: 'hero',
      crop: 'desktop',
      codec: 'hevc',
    })
    expect(path).toBe(`/m/${MEDIA_ID}/${HASH}/hero-video-desktop-hevc.mp4`)
    expect(path).toMatch(VIDEO_RENDITION_PATH_PATTERN)
    // The two kinds share a directory and must never be parsed as each other: the next/image loader would
    // otherwise be handed an .mp4 and asked which rung it is.
    expect(path).not.toMatch(DERIVATIVE_PATH_PATTERN)
    expect(`/m/${MEDIA_ID}/${HASH}/hero-desktop-2560.avif`).not.toMatch(
      VIDEO_RENDITION_PATH_PATTERN,
    )
  })

  it('gives four distinct paths and moves all four when the master changes', () => {
    const first = videoRenditionPaths({ mediaId: MEDIA_ID, contentHash: HASH, slot: 'hero' })
    expect(new Set(first).size).toBe(4)
    for (const path of first) expect(path).toMatch(VIDEO_RENDITION_PATH_PATTERN)
    const second = videoRenditionPaths({
      mediaId: MEDIA_ID,
      contentHash: 'fedcba9876543210',
      slot: 'hero',
    })
    // A re-graded master is a different content address, so nothing anywhere has to be purged — which is
    // the whole basis for a year of `immutable`.
    expect(first.some((path) => second.includes(path))).toBe(false)
  })

  it('refuses an id or a hash that is not one', () => {
    const ref = { contentHash: HASH, slot: 'hero', crop: 'mobile', codec: 'h264' } as const
    expect(() => videoRenditionPath({ ...ref, mediaId: 'hero-1' })).toThrow(/invalid-media-id/)
    expect(() => videoRenditionPath({ ...ref, mediaId: MEDIA_ID, contentHash: 'XYZ' })).toThrow(
      /invalid-content-hash/,
    )
  })

  it('keeps a master out of the URL space entirely', () => {
    const key = videoMasterKey(MEDIA_ID, '.Y4M')
    expect(key).toBe(`video-masters/${MEDIA_ID}.y4m`)
    expect(isVideoMasterKey(key)).toBe(true)
    // The controls: an image original and an arbitrary private object are both refused by the same check.
    expect(isVideoMasterKey(`originals/${MEDIA_ID}.jpg`)).toBe(false)
    expect(isVideoMasterKey('consent/signed-2026.pdf')).toBe(false)
    expect(Object.values(MASTER_EXTENSIONS)).toContain('y4m')
  })
})

describe('the byte caps', () => {
  it('are docs/08 §8 numbers, and the hard stop is above both budgets', () => {
    expect(VIDEO_BUDGET_BYTES.mobile).toBe(350 * 1024)
    expect(VIDEO_BUDGET_BYTES.desktop).toBe(Math.round(1.2 * 1024 * 1024))
    expect(VIDEO_HARD_STOP_BYTES).toBe(2 * 1024 * 1024)
    // If the hard stop were at or below a budget the job would refuse before CI could measure a breach, and
    // the hard stop could never fire — a rule that has never been able to fail is ADR 0003's subject.
    for (const crop of ['mobile', 'desktop'] as const) {
      expect(VIDEO_HARD_STOP_BYTES).toBeGreaterThan(VIDEO_BUDGET_BYTES[crop])
    }
  })

  it('refuses the hard stop by name, with the measured number', () => {
    const over = { crop: 'mobile', codec: 'h264', bytes: VIDEO_HARD_STOP_BYTES + 1 } as const
    expect(() => assertWithinHardStop(over)).toThrow(/\[video-rendition-over-hard-stop\]/)
    expect(() => assertWithinHardStop(over)).toThrow(String(VIDEO_HARD_STOP_BYTES + 1))
    // The control, one byte down: exactly at the hard stop is allowed, so the rule is a threshold rather
    // than a refusal of everything.
    expect(() =>
      assertWithinHardStop({ crop: 'mobile', codec: 'h264', bytes: VIDEO_HARD_STOP_BYTES }),
    ).not.toThrow()
  })

  it('reports a budget breach with the measured number rather than refusing it', () => {
    const weight = { crop: 'mobile', codec: 'hevc', bytes: VIDEO_BUDGET_BYTES.mobile + 1 } as const
    expect(isWithinBudget(weight)).toBe(false)
    expect(overBudgetMessage(weight)).toContain('[video-rendition-over-budget]')
    expect(overBudgetMessage(weight)).toContain(String(VIDEO_BUDGET_BYTES.mobile + 1))
    // Over the budget is not over the hard stop, which is exactly the gap the two thresholds create.
    expect(() => assertWithinHardStop(weight)).not.toThrow()
    expect(isWithinBudget({ ...weight, bytes: VIDEO_BUDGET_BYTES.mobile })).toBe(true)
  })
})

describe('the master', () => {
  it('accepts a correct one, which is what makes every refusal below one field away', () => {
    expect(masterViolations(GOOD_MASTER)).toEqual([])
    expect(() => assertMasterAcceptable(GOOD_MASTER)).not.toThrow()
  })

  it.each([
    ['video-master-mime-not-allowed', { mimeType: 'image/jpeg' }],
    ['video-master-over-maximum-bytes', { byteLength: maxMasterBytes('video/mp4') + 1 }],
    ['video-master-too-long-to-ping-pong', { durationSeconds: MAX_MASTER_SECONDS + 0.1 }],
    ['video-master-below-minimum-dimensions', { width: 1280, height: 720 }],
    ['video-master-ratio-out-of-tolerance', { width: 1920, height: 1440 }],
  ])('refuses %s', (rule, override) => {
    const violations = masterViolations({ ...GOOD_MASTER, ...override })
    expect(violations.map((violation) => violation.rule)).toContain(rule)
    expect(() => assertMasterAcceptable({ ...GOOD_MASTER, ...override })).toThrow(
      new RegExp(`\\[${rule}\\]`),
    )
  })

  it('caps the bytes per container, because a y4m of the same footage is ten times an MP4', () => {
    // Found by a test rather than by a review: one cap for both containers refused this unit's own stand-in
    // master. A y4m is 3.11MB per 1080p frame, so three seconds is 233MB uncompressed and about 20MB coded.
    expect(maxMasterBytes('video/x-yuv4mpegpipe')).toBeGreaterThan(maxMasterBytes('video/mp4'))
    expect(
      masterViolations({
        ...GOOD_MASTER,
        mimeType: 'video/x-yuv4mpegpipe',
        byteLength: 200 * 1024 * 1024,
      }),
    ).toEqual([])
    // The control, and the reason the fallback is the tightest rather than the loosest: an unknown container
    // does not get the y4m allowance.
    expect(
      masterViolations({
        ...GOOD_MASTER,
        mimeType: 'video/x-matroska',
        byteLength: 200 * 1024 * 1024,
      }).map((violation) => violation.rule),
    ).toContain('video-master-over-maximum-bytes')
  })

  it('will not upscale, so the floor is the widest rendition', () => {
    const widest = VIDEO_RENDITIONS.reduce((a, b) => (b.width > a.width ? b : a))
    expect(MIN_MASTER_WIDTH).toBe(widest.width)
    expect(MIN_MASTER_HEIGHT).toBe(widest.height)
  })
})

describe('how a video relates to the hero image slot', () => {
  it('does not widen the image slot to accept a master', () => {
    const relation = heroVideoRelation()
    expect(relation.slot).toBe(HERO_VIDEO_SLOT)
    // The load-bearing assertion. The hero slot's descriptor drives the AVIF ladder, the OKLCH
    // placeholder, the aspect-ratio a card reserves and the alt-text filter; a master eligible for those
    // would be handed to twenty-four sharp encodes and would fail somewhere inside libvips.
    expect(relation.slotAcceptsVideo).toBe(false)
    const slot = mediaSlot(HERO_VIDEO_SLOT)
    expect(slot.mimeTypes).toEqual(['image/jpeg', 'image/png'])
    for (const mime of VIDEO_MASTER_MIME_TYPES) {
      expect(slot.mimeTypes as readonly string[]).not.toContain(mime)
    }
  })

  it('refuses a video upload into the image slot by the slot registry’s own rule', () => {
    const asVideo = validateUpload({
      slot: HERO_VIDEO_SLOT,
      mimeType: 'video/mp4',
      byteLength: 4 * 1024 * 1024,
      width: 1920,
      height: 1080,
      filename: 'hero-loop.mp4',
      focal: { x: 50, y: 50 },
    })
    expect(asVideo.map((violation) => violation.rule)).toContain('slot-mime-not-allowed')
    // The control: the same frame as a JPEG is accepted, so the refusal is about the container and not
    // about the dimensions or the focal point.
    expect(
      validateUpload({
        slot: HERO_VIDEO_SLOT,
        mimeType: 'image/jpeg',
        byteLength: 4 * 1024 * 1024,
        width: 1920,
        height: 1080,
        filename: 'hero-team.jpg',
        focal: { x: 50, y: 50 },
      }),
    ).toEqual([])
  })

  it('shares the two crops with the poster rather than declaring its own', () => {
    const relation = heroVideoRelation()
    expect(relation.ratios.desktop).toBeCloseTo(16 / 9, 5)
    expect(relation.ratios.mobile).toBeCloseTo(4 / 5, 5)
    // And the renditions really are those two shapes, so `<picture>` and `<video>` cannot art-direct
    // differently.
    for (const rendition of VIDEO_RENDITIONS) {
      expect(rendition.width / rendition.height).toBeCloseTo(relation.ratios[rendition.crop], 2)
    }
  })
})
