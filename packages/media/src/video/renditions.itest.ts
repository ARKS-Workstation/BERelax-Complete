import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFakeMediaStorage, PUT_LOG } from '../storage/fake.ts'
import {
  IMMUTABLE_CACHE_CONTROL,
  type MediaStorage,
  PRIVATE_CACHE_CONTROL,
  publicKeyFor,
} from '../storage/port.ts'
import {
  buildVideoRenditions,
  describeMaster,
  type EncodeRequest,
  storeVideoMaster,
  type VideoEncoder,
} from './encode.ts'
import {
  FORBIDDEN_CONTAINERS,
  REQUIRED_CODEC_TAG,
  VIDEO_CONTENT_TYPE,
  VIDEO_RENDITION_PATH_PATTERN,
  videoMasterKey,
} from './ladder.ts'
import { probeMp4 } from './probe.ts'
import { standInMasterY4m } from './stand-in.ts'
import { standInMp4 } from './testing.ts'

/**
 * The pipeline against the storage adapter that writes real bytes to a real directory.
 *
 * `encode.test.ts` proves the orchestration over an in-memory map. This file exists for the one property a
 * map cannot show: **the bucket split is a directory on disk, and the master is not in the public half of
 * it.** docs/08 §6 makes that split a security boundary rather than an organisational one, and the fake
 * adapter mirrors the bucket layout precisely so that an object written to the wrong bucket is visible as a
 * file in the wrong folder. A flattened outbox would hide exactly that.
 *
 * The master is the marked stand-in built from `assets/media/photos/hero-team.jpg`, at the real 1920×1080
 * geometry the pipeline requires. There is no hero footage (`Y12-hero-video`); this is the thing docs/08 §8's
 * cut order already sanctions as a shipping option, and every byte of it is derived from a photograph that
 * really is in this repository.
 *
 * ffmpeg is not installed in the container this unit was developed in, so the encode itself is a stub that
 * produces structurally real MP4s. What that leaves unproven is stated in W-SYS-06's manifest NOTEs; what it
 * leaves *proven* is everything between the master and the bucket.
 */
const MEDIA_ID = '0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e10'
const HERO = new URL('../../../../assets/media/photos/hero-team.jpg', import.meta.url).pathname
const NOW = '2026-09-19T10:00:00.000Z'

let outbox: string
let storage: MediaStorage
let master: Uint8Array
let masterKey: string

function stubEncoder(): VideoEncoder {
  let encodes = 0
  return {
    describe: 'stub encoder (no ffmpeg in this container; structural MP4 only)',
    count: () => encodes,
    async encode(request: EncodeRequest) {
      encodes += 1
      const seconds = describeMaster(request.master, 'y4m').durationSeconds
      return standInMp4({
        codecTag: REQUIRED_CODEC_TAG[request.rendition.codec],
        durationSeconds: seconds * 2,
        timescale: 90_000,
        width: request.rendition.width,
        height: request.rendition.height,
      })
    },
  }
}

/** Every file in the outbox, as bucket-relative paths, so a listing can be asserted as a set. */
function filesUnder(directory: string, prefix = ''): readonly string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    return entry.isDirectory() ? filesUnder(join(directory, entry.name), relative) : [relative]
  })
}

beforeAll(async () => {
  outbox = mkdtempSync(join(tmpdir(), 'berelax-video-outbox-'))
  storage = createFakeMediaStorage({ outbox, now: () => NOW })
  // Three frames at 1920x1080 is 9.3MB uncompressed — enough to be the real geometry the pipeline demands
  // and small enough that the suite does not hold a quarter of a gigabyte.
  master = await standInMasterY4m({
    source: readFileSync(HERO),
    width: 1920,
    height: 1080,
    frames: 3,
  })
  masterKey = await storeVideoMaster({
    mediaId: MEDIA_ID,
    extension: 'y4m',
    master,
    storage,
  })
}, 120_000)

afterAll(() => {
  rmSync(outbox, { recursive: true, force: true })
})

describe('the master in the private bucket', () => {
  it('is on disk under the private prefix, and nowhere under the public one', async () => {
    expect(masterKey).toBe(videoMasterKey(MEDIA_ID, 'y4m'))
    // The file, at the path the bucket layout implies. This is the assertion a map cannot make.
    expect(existsSync(join(outbox, 'private', masterKey))).toBe(true)
    expect(statSync(join(outbox, 'private', masterKey)).size).toBe(master.length)
    expect(existsSync(join(outbox, 'public', masterKey))).toBe(false)
    const stored = await storage.head({ bucket: 'private', key: masterKey })
    expect(stored?.cacheControl).toBe(PRIVATE_CACHE_CONTROL)
    // Not publicly readable: the same key in the public bucket is absent, and the adapter says so rather
    // than returning the private object.
    expect(await storage.head({ bucket: 'public', key: masterKey })).toBeUndefined()
  })

  it('is recorded as a stand-in rather than as footage', () => {
    const described = describeMaster(master, 'y4m')
    expect(described.standIn).toBe(true)
    expect(described.width).toBe(1920)
    expect(described.height).toBe(1080)
  })
})

describe('the four renditions in the public bucket', () => {
  it('writes exactly four MP4s, immutable, and zero of anything else', async () => {
    const encoder = stubEncoder()
    const result = await buildVideoRenditions({
      mediaId: MEDIA_ID,
      slot: 'hero',
      master,
      masterExtension: 'y4m',
      storage,
      encoder,
    })

    expect(result.encoded).toBe(4)
    expect(result.outputs).toHaveLength(4)
    expect(result.master.standIn).toBe(true)

    // The directory listing assertion, made against the filesystem rather than against the adapter's own
    // bookkeeping: four files, all `.mp4`, all under this master's content address.
    const publicFiles = filesUnder(join(outbox, 'public'))
    expect(publicFiles).toHaveLength(4)
    for (const file of publicFiles) {
      expect(`/${file}`, file).toMatch(VIDEO_RENDITION_PATH_PATTERN)
      expect(file.startsWith(`m/${MEDIA_ID}/${result.contentHash}/`)).toBe(true)
    }
    // docs/08 §6: "Skip VP9/WebM entirely", "No HLS, no hls.js". Zero of each, in the whole outbox.
    const everything = [
      ...filesUnder(join(outbox, 'public')),
      ...filesUnder(join(outbox, 'private')),
    ]
    for (const banned of FORBIDDEN_CONTAINERS) {
      expect(
        everything.filter((file) => file.endsWith(`.${banned}`)),
        banned,
      ).toEqual([])
    }

    for (const output of result.outputs) {
      const head = await storage.head({ bucket: 'public', key: publicKeyFor(output.path) })
      expect(head?.cacheControl, output.path).toBe(IMMUTABLE_CACHE_CONTROL)
      expect(head?.contentType).toBe(VIDEO_CONTENT_TYPE)
      // Read the stored bytes back off disk and probe those, not the buffer the encoder returned.
      const body = readFileSync(join(outbox, 'public', publicKeyFor(output.path)))
      const probe = probeMp4(body)
      expect(probe.faststart).toBe(true)
      expect(probe.codecTag).toBe(REQUIRED_CODEC_TAG[output.codec])
    }
  }, 120_000)

  it('leaves a put log a person can look at', () => {
    // docs/12 §1: a fake sends to a visible outbox; it does not pretend to have uploaded. Five puts — the
    // master and the four renditions — each a line somebody can read.
    const log = readFileSync(join(outbox, PUT_LOG), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as { bucket: string; key: string; cacheControl: string })
    expect(log).toHaveLength(5)
    expect(log.filter((entry) => entry.bucket === 'private')).toHaveLength(1)
    expect(log.filter((entry) => entry.bucket === 'public')).toHaveLength(4)
    for (const entry of log.filter((line) => line.bucket === 'public')) {
      expect(entry.cacheControl).toBe(IMMUTABLE_CACHE_CONTROL)
    }
  })

  it('re-encodes nothing on a second pass over the same master', async () => {
    const encoder = stubEncoder()
    const result = await buildVideoRenditions({
      mediaId: MEDIA_ID,
      slot: 'hero',
      master,
      masterExtension: 'y4m',
      storage,
      encoder,
    })
    expect(result.encoded).toBe(0)
    expect(encoder.count()).toBe(0)
    expect(result.reused).toBe(4)
    // And nothing new on disk, which is what "reused" has to mean for an immutable path.
    expect(filesUnder(join(outbox, 'public'))).toHaveLength(4)
  }, 120_000)
})
