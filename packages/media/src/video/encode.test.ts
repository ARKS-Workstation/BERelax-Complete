import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sha256Hex } from '../hash.ts'
import {
  IMMUTABLE_CACHE_CONTROL,
  type MediaBucket,
  type MediaStorage,
  PRIVATE_CACHE_CONTROL,
  publicKeyFor,
  type StoredObject,
} from '../storage/port.ts'
import {
  assertVideoSlot,
  buildVideoRenditions,
  describeMaster,
  detectFfmpegLicence,
  type EncodeRequest,
  FFMPEG_DECLARED_LICENCES,
  resolveFfmpeg,
  storeVideoMaster,
  type VideoEncoder,
} from './encode.ts'
import {
  FORBIDDEN_CONTAINERS,
  REQUIRED_CODEC_TAG,
  VIDEO_BUDGET_BYTES,
  VIDEO_CONTENT_TYPE,
  VIDEO_HARD_STOP_BYTES,
  VIDEO_RENDITION_PATH_PATTERN,
  VIDEO_RENDITIONS,
  videoMasterKey,
} from './ladder.ts'
import { probeMp4 } from './probe.ts'
import { STAND_IN_MARKER, standInMp4 } from './testing.ts'

const MEDIA_ID = '0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e1f'

/*
 * ── The two doubles, and why they are what they are ─────────────────────────────────────────────────
 *
 * **A fake ffmpeg on disk, not a mocked module.** `resolveFfmpeg` exists to answer three questions about a
 * binary — is it there, what licence is it, does it have the encoders — and every one of those is read from
 * a real subprocess. Mocking `execFile` would test the mock. A shell script in a temp directory with an
 * injected search path tests the thing, and it does so *deterministically*: this suite behaves identically
 * on a machine with no ffmpeg and on a CI runner that has one, which a test keyed on the real PATH would
 * not.
 *
 * **An in-memory storage adapter.** `packages/media/src/storage/fake.ts` writes real files and is the right
 * subject for the integration suite (`renditions.itest.ts` uses it). Here the subject is the orchestration
 * — the head check that makes a second run free, the probe, the caps, the bucket split — and a map is
 * enough for that and costs no filesystem.
 */
function memoryStorage(): MediaStorage {
  const objects = new Map<string, { object: StoredObject; body: Uint8Array }>()
  const at = (bucket: MediaBucket, key: string): string => `${bucket}/${key}`
  return {
    kind: 'fake',
    outbox: undefined,
    async put(request) {
      const object: StoredObject = {
        bucket: request.bucket,
        key: request.key,
        bytes: request.body.length,
        sha256: sha256Hex(request.body),
        contentType: request.contentType,
        cacheControl: request.cacheControl,
      }
      objects.set(at(request.bucket, request.key), { object, body: request.body })
      return object
    },
    async head(location) {
      return objects.get(at(location.bucket, location.key))?.object
    },
    async get(location) {
      const found = objects.get(at(location.bucket, location.key))
      if (found === undefined) throw new Error(`[outbox-object-absent] ${location.key}`)
      return found.body
    },
    async list(bucket) {
      return [...objects.keys()]
        .filter((key) => key.startsWith(`${bucket}/`))
        .map((key) => key.slice(bucket.length + 1))
        .sort()
    },
  }
}

interface StubOptions {
  readonly codecTagFor?: (request: EncodeRequest) => string
  readonly bytesFor?: (request: EncodeRequest) => number
  readonly faststart?: boolean
  readonly durationFactor?: number
}

/**
 * An encoder that produces structurally real MP4s and nothing decodable.
 *
 * The counter is inside the closure, exactly as `createFfmpegEncoder`'s is, because the acceptance is "a
 * second run re-encodes nothing (encode counter 0)" and a number the orchestrating loop maintained would be
 * the loop asserting its own branch.
 */
function stubEncoder(options: StubOptions = {}): VideoEncoder {
  let encodes = 0
  return {
    describe: 'stub encoder (no ffmpeg; structural MP4 only)',
    count: () => encodes,
    async encode(request) {
      encodes += 1
      const masterSeconds = describeMaster(request.master, 'y4m').durationSeconds
      return standInMp4({
        codecTag: options.codecTagFor?.(request) ?? REQUIRED_CODEC_TAG[request.rendition.codec],
        faststart: options.faststart ?? true,
        durationSeconds: masterSeconds * (options.durationFactor ?? 2),
        timescale: 90_000,
        width: request.rendition.width,
        height: request.rendition.height,
        ...(options.bytesFor === undefined ? {} : { padToBytes: options.bytesFor(request) }),
      })
    },
  }
}

/** A y4m master, built by hand so this file needs neither sharp nor a photograph. */
function y4mMaster(
  options: {
    width?: number
    height?: number
    frames?: number
    frameRate?: number
    marked?: boolean
  } = {},
): Uint8Array {
  const width = options.width ?? 1920
  const height = options.height ?? 1080
  const frames = options.frames ?? 2
  const frameRate = options.frameRate ?? 25
  const marker = options.marked === false ? '' : ` X${STAND_IN_MARKER}`
  const header = Buffer.from(
    `YUV4MPEG2 W${width} H${height} F${frameRate}:1 Ip A1:1 C420mpeg2${marker}\n`,
    'ascii',
  )
  const plane = Buffer.alloc((width * height * 3) / 2, 0x40)
  const parts: Buffer[] = [header]
  for (let frame = 0; frame < frames; frame += 1) {
    parts.push(Buffer.from('FRAME\n', 'ascii'), plane)
  }
  return Buffer.concat(parts)
}

const MASTER = y4mMaster()

const buildWith = async (encoder: VideoEncoder, storage: MediaStorage, master = MASTER) =>
  await buildVideoRenditions({
    mediaId: MEDIA_ID,
    slot: 'hero',
    master,
    masterExtension: 'y4m',
    storage,
    encoder,
  })

describe('finding ffmpeg', () => {
  let binDirectory: string

  const writeFake = (name: string, script: string): void => {
    const path = join(binDirectory, name)
    writeFileSync(path, script)
    chmodSync(path, 0o755)
  }

  const GPL_BANNER =
    'ffmpeg version 6.1.1-3+deb12u1\n' +
    'configuration: --prefix=/usr --enable-gpl --enable-version3 --enable-libx264 --enable-libx265\n'
  const LGPL_BANNER =
    'ffmpeg version 6.1.1-lgpl\nconfiguration: --prefix=/usr --enable-libopenh264\n'
  const BOTH_ENCODERS = 'Encoders:\n V....D libx264 H.264\n V....D libx265 HEVC\n'

  // `%b` rather than `%s`: printf interprets backslash escapes in its *format*, not in its arguments, so
  // `%s` would emit one line containing a literal `\n` and the encoder list would parse as a single row.
  // That mistake made this suite pass for the wrong reason once — the licence was still detected because the
  // configuration pattern stops at a newline and there was none.
  const fakeFfmpeg = (banner: string, encoders: string): string =>
    [
      '#!/bin/sh',
      'case "$*" in',
      `  *-version*) printf '%b' '${banner.replace(/\n/g, '\\n')}' ;;`,
      `  *-encoders*) printf '%b' '${encoders.replace(/\n/g, '\\n')}' ;;`,
      'esac',
      '',
    ].join('\n')

  beforeAll(() => {
    binDirectory = mkdtempSync(join(tmpdir(), 'berelax-fake-ffmpeg-'))
    writeFake('ffprobe', '#!/bin/sh\nprintf "{}"\n')
  })

  afterAll(() => {
    rmSync(binDirectory, { recursive: true, force: true })
  })

  it('refuses by name when there is no ffmpeg, and says where it looked', async () => {
    // The whole point of the injected search path: this is the state of the container this unit was written
    // in, and it has to be assertable on a machine that does have ffmpeg.
    const empty = mkdtempSync(join(tmpdir(), 'berelax-empty-bin-'))
    try {
      await expect(resolveFfmpeg({ searchPath: [empty] })).rejects.toThrow(
        /\[ffmpeg-not-available\]/,
      )
      await expect(resolveFfmpeg({ searchPath: [empty] })).rejects.toThrow(empty)
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('refuses a half-installed toolchain separately', async () => {
    const onlyFfmpeg = mkdtempSync(join(tmpdir(), 'berelax-half-bin-'))
    try {
      const path = join(onlyFfmpeg, 'ffmpeg')
      writeFileSync(path, fakeFfmpeg(GPL_BANNER, BOTH_ENCODERS))
      chmodSync(path, 0o755)
      // ffprobe is the independent reading of what was produced. With only one witness there is nothing for
      // the byte parser to agree with, which is a different failure from having no encoder at all.
      await expect(resolveFfmpeg({ searchPath: [onlyFfmpeg] })).rejects.toThrow(
        /\[ffprobe-not-available\]/,
      )
    } finally {
      rmSync(onlyFfmpeg, { recursive: true, force: true })
    }
  })

  it('accepts the GPL build the image notice covers, and reports what it found', async () => {
    writeFake('ffmpeg', fakeFfmpeg(GPL_BANNER, BOTH_ENCODERS))
    const tools = await resolveFfmpeg({ searchPath: [binDirectory] })
    expect(tools.licence).toBe('GPL-3.0-or-later')
    expect(FFMPEG_DECLARED_LICENCES).toContain(tools.licence)
    expect(tools.version).toContain('ffmpeg version 6.1.1')
    expect(tools.encoders).toContain('libx264')
    expect(tools.encoders).toContain('libx265')
  })

  it('refuses a build whose licence the image notice does not cover', async () => {
    // An LGPL build is LESS obligation and still makes the shipped notice wrong, which is why the rule fires
    // in both directions rather than only on an upgrade to something stricter.
    writeFake('ffmpeg', fakeFfmpeg(LGPL_BANNER, BOTH_ENCODERS))
    await expect(resolveFfmpeg({ searchPath: [binDirectory] })).rejects.toThrow(
      /\[ffmpeg-build-licence-unexpected\]/,
    )
    await expect(resolveFfmpeg({ searchPath: [binDirectory] })).rejects.toThrow(/LGPL/)
  })

  it('refuses a build without the encoders the renditions are specified with', async () => {
    // `-c:v h264` on this build would silently select OpenH264 — Constrained Baseline, no CRF — and produce
    // four files nobody specified. Naming the encoder is what makes "a rendition was produced" and "the
    // specified rendition was produced" the same statement.
    writeFake('ffmpeg', fakeFfmpeg(GPL_BANNER, 'Encoders:\n V....D libopenh264 OpenH264\n'))
    await expect(resolveFfmpeg({ searchPath: [binDirectory] })).rejects.toThrow(
      /\[video-encoder-not-available\]/,
    )
    await expect(resolveFfmpeg({ searchPath: [binDirectory] })).rejects.toThrow(/libx264/)
  })

  it('derives the licence from the configuration line rather than assuming one', () => {
    expect(detectFfmpegLicence('--enable-gpl --enable-version3')).toBe('GPL-3.0-or-later')
    expect(detectFfmpegLicence('--enable-gpl --enable-libx264')).toBe('GPL-2.0-or-later')
    // libx264 and libx265 cannot be included without --enable-gpl, which is the whole basis of the
    // obligation recorded in build/container-policy.json.
    expect(detectFfmpegLicence('--enable-libopenh264')).toBe('LGPL-2.1-or-later')
    expect(detectFfmpegLicence('--enable-version3 --enable-libkvazaar')).toBe('LGPL-3.0-or-later')
  })
})

describe('measuring a master', () => {
  it('reads a y4m from its header and reports that it is a stand-in', () => {
    const master = describeMaster(MASTER, 'y4m')
    expect(master.width).toBe(1920)
    expect(master.height).toBe(1080)
    expect(master.frameRate).toBe(25)
    expect(master.durationSeconds).toBeCloseTo(2 / 25, 5)
    expect(master.mimeType).toBe('video/x-yuv4mpegpipe')
    // The honesty requirement. There is no hero footage, so a run must be unable to claim it encoded some.
    expect(master.standIn).toBe(true)
    // The control: the same stream without the marker is not reported as a stand-in, so the flag is read
    // rather than hardcoded.
    expect(describeMaster(y4mMaster({ marked: false }), 'y4m').standIn).toBe(false)
  })

  it('reads an MP4 from its boxes', () => {
    const master = describeMaster(
      standInMp4({ width: 1920, height: 1080, durationSeconds: 4, frameRate: 25 }),
      'mp4',
    )
    expect(master.mimeType).toBe('video/mp4')
    expect(master.width).toBe(1920)
    expect(master.durationSeconds).toBeCloseTo(4, 5)
    expect(master.frameRate).toBeCloseTo(25, 5)
    expect(describeMaster(standInMp4(), 'mov').mimeType).toBe('video/quicktime')
  })

  it('refuses something that is neither', () => {
    expect(() => describeMaster(Buffer.from('not a video at all'), 'mp4')).toThrow(
      /\[video-master-unreadable\]/,
    )
  })
})

describe('the master stays private', () => {
  it('goes to the private bucket with no-store, and is not publicly readable', async () => {
    const storage = memoryStorage()
    const key = await storeVideoMaster({
      mediaId: MEDIA_ID,
      extension: 'y4m',
      master: MASTER,
      storage,
    })
    expect(key).toBe(videoMasterKey(MEDIA_ID, 'y4m'))
    const stored = await storage.head({ bucket: 'private', key })
    expect(stored?.cacheControl).toBe(PRIVATE_CACHE_CONTROL)
    expect(stored?.contentType).toBe('video/x-yuv4mpegpipe')
    // docs/08 §6's bucket split is a security boundary. The same key in the public bucket must be absent,
    // and the public bucket must hold nothing at all before a build.
    expect(await storage.head({ bucket: 'public', key })).toBeUndefined()
    expect(await storage.list('public')).toEqual([])
  })
})

describe('the four renditions', () => {
  it('emits exactly four MP4s and nothing else', async () => {
    const storage = memoryStorage()
    const encoder = stubEncoder()
    const result = await buildWith(encoder, storage)

    expect(result.outputs).toHaveLength(4)
    expect(result.encoded).toBe(4)
    expect(result.reused).toBe(0)
    expect(encoder.count()).toBe(4)

    const keys = await storage.list('public')
    expect(keys).toHaveLength(4)
    for (const key of keys) {
      expect(`/${key}`, key).toMatch(VIDEO_RENDITION_PATH_PATTERN)
      expect(key.endsWith('.mp4')).toBe(true)
      for (const banned of FORBIDDEN_CONTAINERS) expect(key).not.toContain(`.${banned}`)
    }
    // The directory listing assertion the acceptance asks for, stated as a set rather than a count: a fifth
    // rendition of any kind would fail this, and so would a missing one.
    expect(new Set(keys)).toEqual(new Set(result.outputs.map((o) => publicKeyFor(o.path))))
    expect(new Set(result.outputs.map((o) => `${o.crop}/${o.codec}`))).toEqual(
      new Set(VIDEO_RENDITIONS.map((r) => `${r.crop}/${r.codec}`)),
    )
    // And the master's provenance is carried through, so nothing downstream can report footage.
    expect(result.master.standIn).toBe(true)
    expect(result.encoder).toContain('stub encoder')
  })

  it('serves every rendition immutable, from the public bucket', async () => {
    const storage = memoryStorage()
    const result = await buildWith(stubEncoder(), storage)
    for (const output of result.outputs) {
      const stored = await storage.head({ bucket: 'public', key: publicKeyFor(output.path) })
      expect(stored?.cacheControl, output.path).toBe(IMMUTABLE_CACHE_CONTROL)
      expect(stored?.contentType).toBe(VIDEO_CONTENT_TYPE)
      expect(stored?.sha256).toBe(output.sha256)
    }
    // Nothing reached the private bucket: this job reads from it and never writes to it.
    expect(await storage.list('private')).toEqual([])
  })

  it('reads the codec tag and the box order back out of the stored bytes', async () => {
    const storage = memoryStorage()
    const result = await buildWith(stubEncoder(), storage)
    for (const output of result.outputs) {
      const body = await storage.get({ bucket: 'public', key: publicKeyFor(output.path) })
      const probe = probeMp4(body)
      expect(probe.faststart, output.path).toBe(true)
      expect(probe.codecTag).toBe(REQUIRED_CODEC_TAG[output.codec])
      expect(output.codecTag).toBe(probe.codecTag)
      expect(output.faststart).toBe(true)
    }
    // Both HEVC renditions carry hvc1, which is the half of the acceptance Safari depends on.
    const hevc = result.outputs.filter((output) => output.codec === 'hevc')
    expect(hevc).toHaveLength(2)
    for (const output of hevc) expect(output.codecTag).toBe('hvc1')
  })

  it('re-encodes nothing on a second run and reuses the same paths', async () => {
    const storage = memoryStorage()
    const first = await buildWith(stubEncoder(), storage)
    const secondEncoder = stubEncoder()
    const second = await buildWith(secondEncoder, storage)

    // The acceptance, and the counter is inside the encoder so this is the encoder reporting rather than the
    // loop reporting its own branch.
    expect(second.encoded).toBe(0)
    expect(secondEncoder.count()).toBe(0)
    expect(second.reused).toBe(4)
    expect(second.contentHash).toBe(first.contentHash)
    expect(second.outputs.map((o) => o.path)).toEqual(first.outputs.map((o) => o.path))
    expect(second.outputs.map((o) => o.sha256)).toEqual(first.outputs.map((o) => o.sha256))
    expect(await storage.list('public')).toHaveLength(4)
  })

  it('moves every path when the master changes', async () => {
    const storage = memoryStorage()
    const first = await buildWith(stubEncoder(), storage)
    const regraded = await buildWith(stubEncoder(), storage, y4mMaster({ frames: 3 }))
    expect(regraded.contentHash).not.toBe(first.contentHash)
    expect(regraded.outputs.some((o) => first.outputs.some((f) => f.path === o.path))).toBe(false)
    // A year of `immutable` needs no purge because the old objects are still there under the old address.
    expect(await storage.list('public')).toHaveLength(8)
  })
})

describe('the caps', () => {
  it('refuses a rendition over the 2MB hard stop and stores nothing for it', async () => {
    const storage = memoryStorage()
    const encoder = stubEncoder({ bytesFor: () => VIDEO_HARD_STOP_BYTES + 1 })
    await expect(buildWith(encoder, storage)).rejects.toThrow(/\[video-rendition-over-hard-stop\]/)
    await expect(
      buildWith(stubEncoder({ bytesFor: () => VIDEO_HARD_STOP_BYTES + 1 }), storage),
    ).rejects.toThrow(String(VIDEO_HARD_STOP_BYTES + 1))
    // The refusal is before the put, so a rendition the job would not publish is not in the bucket.
    expect(await storage.list('public')).toEqual([])
  })

  it('publishes an over-budget rendition and reports it with the measured number', async () => {
    // docs/08 §8 puts the per-crop budget in the CI layer and the hard stop in the job. If the job refused at
    // the budget the hard stop could never fire, so this is the gap between the two thresholds.
    const oversized = VIDEO_BUDGET_BYTES.mobile + 1024
    const storage = memoryStorage()
    const result = await buildWith(stubEncoder({ bytesFor: () => oversized }), storage)
    expect(result.overBudget.length).toBeGreaterThan(0)
    expect(result.overBudget.join(' ')).toContain('[video-rendition-over-budget]')
    expect(result.overBudget.join(' ')).toContain(String(oversized))
    expect(await storage.list('public')).toHaveLength(4)
    // The desktop budget is larger, so the same byte count is inside it — which is why the message names the
    // crop and why the two numbers are per-crop rather than one.
    const mobile = result.outputs.filter((o) => o.crop === 'mobile')
    const desktop = result.outputs.filter((o) => o.crop === 'desktop')
    expect(mobile.every((o) => o.withinBudget)).toBe(false)
    expect(desktop.every((o) => o.withinBudget)).toBe(true)
  })

  it('refuses the master before spending an encode on it', async () => {
    const storage = memoryStorage()
    const encoder = stubEncoder()
    await expect(
      buildWith(encoder, storage, y4mMaster({ width: 1280, height: 720 })),
    ).rejects.toThrow(/\[video-master-below-minimum-dimensions\]/)
    // Nothing was encoded. Four `veryslow` passes is an hour; discovering then that the master was 1280 wide
    // is an hour spent producing four upscaled files.
    expect(encoder.count()).toBe(0)
    expect(await storage.list('public')).toEqual([])
  })
})

describe('what the job refuses to publish', () => {
  it('refuses an HEVC rendition tagged hev1', async () => {
    const storage = memoryStorage()
    await expect(buildWith(stubEncoder({ codecTagFor: () => 'hev1' }), storage)).rejects.toThrow(
      /\[mp4-codec-tag-unexpected\]/,
    )
  })

  it('refuses an MP4 whose moov follows its mdat', async () => {
    const storage = memoryStorage()
    await expect(buildWith(stubEncoder({ faststart: false }), storage)).rejects.toThrow(
      /\[mp4-moov-after-mdat\]/,
    )
  })

  it('refuses a rendition that is not twice the master', async () => {
    // The reverse leg did not run, so `<video loop>` cuts at the wrap instead of turning.
    const storage = memoryStorage()
    await expect(buildWith(stubEncoder({ durationFactor: 1 }), storage)).rejects.toThrow(
      /\[ping-pong-duration-wrong\]/,
    )
  })

  it('refuses an unexpected object under the same content address', async () => {
    const storage = memoryStorage()
    const result = await buildWith(stubEncoder(), storage)
    // docs/08 §6 says "Skip VP9/WebM entirely" and "No HLS". The way that stops being true is a fifth
    // rendition arriving with its own argv, so what is in the bucket is the fact rather than the flags.
    await storage.put({
      bucket: 'public',
      key: `m/${MEDIA_ID}/${result.contentHash}/hero-video-desktop-vp9.webm`,
      body: Buffer.from('nope'),
      contentType: 'video/webm',
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    })
    await expect(buildWith(stubEncoder(), storage)).rejects.toThrow(/\[unexpected-video-output\]/)
  })

  it('only builds video for the one slot that has it', () => {
    expect(assertVideoSlot('hero')).toBe('hero')
    // A wordmark has no ratio and is never cropped; producing a 1920x1080 ping-pong loop of one is not a
    // thing to do quietly.
    expect(() => assertVideoSlot('logo')).toThrow(/\[slot-has-no-video\]/)
    expect(() => assertVideoSlot('therapist-portrait')).toThrow(/\[slot-has-no-video\]/)
    expect(() => assertVideoSlot('not-a-slot')).toThrow(/\[unknown-slot\]/)
  })
})
