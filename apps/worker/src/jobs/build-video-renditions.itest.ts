import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFakeMediaStorage,
  describeMaster,
  type EncodeRequest,
  type MediaStorage,
  REQUIRED_CODEC_TAG,
  standInMasterY4m,
  standInMp4,
  storeVideoMaster,
  VIDEO_RENDITION_PATH_PATTERN,
  type VideoEncoder,
  videoMasterKey,
} from '@berelax/media'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { assertRegistry, cronRegistrations, JOB_REGISTRY } from '../registry.ts'
import { runJobBody } from '../testing/harness.ts'
import {
  BUILD_VIDEO_RENDITIONS_JOB,
  runBuildVideoRenditions,
  setVideoEncoderFactory,
  setVideoRenditionStorage,
} from './build-video-renditions.ts'

/**
 * The job, through the worker's own harness.
 *
 * The pipeline itself is proved in `packages/media/src/video/*`. What this file is for:
 *
 * **It is a queue and not a cron.** A rendition build is announced by the upload that wrote the master, so it
 * has no schedule and therefore needs no `agent_definition` — and that has to be asserted, because the easy
 * mistake is to add a `cron` "so it catches up", which `assertRegistry` would then reject for having no
 * agent nobody wrote.
 *
 * **With no ffmpeg it fails loudly.** `which ffmpeg` in the container this unit was written in returns
 * nothing, and the failure that matters is not the missing binary — it is a job that completes, logs four
 * renditions and has written nothing. W-SYS-05's `[no-real-media-storage-adapter]` set the precedent.
 *
 * **It reads from the private bucket, and only from under the video-master prefix.**
 *
 * **It uses the injected clock, and says whether its master was a stand-in.**
 *
 * ## The ordering in this file is load-bearing
 *
 * `setVideoRenditionStorage` and `setVideoEncoderFactory` are module-level bindings with no reset — the same
 * shape as `setMediaStorage` and `setMaintenanceSql`, and for the same reason: the registry has to be
 * enumerable by `pnpm jobs` without a bucket, a database or an encoder. So the only moment the "ran before an
 * adapter was supplied" guard and the *default* encoder path can be observed is before the first call to
 * each, and a `describe` moved above them would silently stop testing either.
 */
const NOW = '2026-09-19T10:00:00.000Z'
const MEDIA_ID = '0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e11'
const HERO = new URL('../../../../assets/media/photos/hero-team.jpg', import.meta.url).pathname

let outbox: string
let storage: MediaStorage
let master: Uint8Array
let masterKey: string

function stubEncoder(): VideoEncoder {
  let encodes = 0
  return {
    describe: 'stub encoder (no ffmpeg in this container)',
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

beforeAll(async () => {
  outbox = mkdtempSync(join(tmpdir(), 'berelax-job-video-'))
  storage = createFakeMediaStorage({ outbox, now: () => NOW })
  master = await standInMasterY4m({
    source: readFileSync(HERO),
    width: 1920,
    height: 1080,
    frames: 3,
  })
  masterKey = await storeVideoMaster({ mediaId: MEDIA_ID, extension: 'y4m', master, storage })
}, 120_000)

afterAll(() => {
  rmSync(outbox, { recursive: true, force: true })
})

describe('before an adapter is supplied', () => {
  it('refuses to run rather than reporting a build it did not do', async () => {
    await expect(
      runJobBody(
        BUILD_VIDEO_RENDITIONS_JOB,
        { mediaId: MEDIA_ID, slot: 'hero', masterKey: 'x', masterExtension: 'y4m' },
        { now: NOW },
      ),
    ).rejects.toThrow(/setVideoRenditionStorage/)
  })
})

describe('with no ffmpeg on the path', () => {
  it('fails by name and says where it looked, rather than skipping the renditions', async () => {
    setVideoRenditionStorage(storage)
    // PATH is emptied rather than trusted to be empty. `which ffmpeg` returns nothing in the container this
    // unit was written in, and GitHub's ubuntu-latest runner *does* have ffmpeg — a test keyed on the real
    // PATH would assert opposite things in the two places and would be a check in neither.
    const original = process.env['PATH']
    const empty = mkdtempSync(join(tmpdir(), 'berelax-no-ffmpeg-'))
    process.env['PATH'] = empty
    try {
      await expect(
        runJobBody(
          BUILD_VIDEO_RENDITIONS_JOB,
          { mediaId: MEDIA_ID, slot: 'hero', masterKey, masterExtension: 'y4m' },
          { now: NOW },
        ),
      ).rejects.toThrow(/\[ffmpeg-not-available\]/)
      // Nothing was published. A rendition reported without an encoder behind it is the failure docs/12 §1
      // prohibits, and the evidence is that the public bucket is still empty.
      expect(await storage.list('public')).toEqual([])
    } finally {
      process.env['PATH'] = original
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

describe('the registry entry', () => {
  it('is a queue with no cron, and therefore no agent', () => {
    const declared = JOB_REGISTRY.find((job) => job.name === 'media.build-video-renditions')
    expect(declared).toBeDefined()
    expect(declared?.cron).toBeUndefined()
    expect(declared?.agent).toBeUndefined()
    // The control: the registry does contain crons and every one of them names an agent, so "no agent" is a
    // property of this job rather than of a registry where the field is never set.
    const crons = cronRegistrations()
    expect(crons.length).toBeGreaterThan(0)
    for (const cron of crons) {
      expect(cron.agent, cron.name).toBeDefined()
      expect(cron.name).not.toBe('media.build-video-renditions')
    }
    expect(() => assertRegistry(JOB_REGISTRY)).not.toThrow()
  })

  it('allows long enough for four veryslow encodes, two of them x265', () => {
    // pg-boss reclaims a job at `expireInSeconds` and retries it. A ten-minute ceiling — which is right for
    // the image job's twenty-four sharp encodes — would dead-letter every video build part-way through and
    // then start it again, forever.
    expect(BUILD_VIDEO_RENDITIONS_JOB.expireInSeconds).toBeGreaterThanOrEqual(3600)
    const images = JOB_REGISTRY.find((job) => job.name === 'media.build-derivatives')
    expect(BUILD_VIDEO_RENDITIONS_JOB.expireInSeconds).toBeGreaterThan(images?.expireInSeconds ?? 0)
    expect(BUILD_VIDEO_RENDITIONS_JOB.retryLimit).toBeGreaterThanOrEqual(1)
  })
})

describe('the handler', () => {
  it('builds the four renditions and names the stand-in master in its log line', async () => {
    setVideoRenditionStorage(storage)
    setVideoEncoderFactory(async () => stubEncoder())
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runJobBody(
        BUILD_VIDEO_RENDITIONS_JOB,
        { mediaId: MEDIA_ID, slot: 'hero', masterKey, masterExtension: 'y4m' },
        { now: NOW },
      )
      const lines = log.mock.calls.map((call) => String(call[0]))
      expect(lines.some((line) => line.includes(NOW))).toBe(true)
      expect(lines.some((line) => line.includes('4 encoded, 0 reused'))).toBe(true)
      // The honesty requirement, in the log rather than only in a document: there is no hero footage, so a
      // run against the marked stand-in has to say so. A line that read the same either way would be the
      // only record of a pipeline that has never seen the real thing.
      expect(lines.some((line) => line.includes('STAND-IN master (Y12-hero-video)'))).toBe(true)
    } finally {
      log.mockRestore()
    }

    const keys = await storage.list('public')
    expect(keys).toHaveLength(4)
    for (const key of keys) {
      expect(`/${key}`, key).toMatch(VIDEO_RENDITION_PATH_PATTERN)
      expect(key).toContain(`m/${MEDIA_ID}/`)
    }
    // The master stayed where it was put and nothing else reached the private bucket.
    expect(await storage.list('private')).toEqual([videoMasterKey(MEDIA_ID, 'y4m')])
  }, 120_000)

  it('refuses a key that is not a private video master', async () => {
    // The key arrives as job data. Without this, a queue message could ask the worker to publish an arbitrary
    // private object — a signed consent PDF, or a full-resolution photograph of a member of staff whose
    // photography consent is not on record (Y12-consent-photo).
    await expect(
      runBuildVideoRenditions(storage, stubEncoder(), {
        mediaId: MEDIA_ID,
        slot: 'hero',
        masterKey: 'consent/signed-2026.pdf',
        masterExtension: 'mp4',
      }),
    ).rejects.toThrow(/\[master-key-outside-video-master-prefix\]/)
    // And an image original is refused too: the two prefixes are different objects with different pipelines.
    await expect(
      runBuildVideoRenditions(storage, stubEncoder(), {
        mediaId: MEDIA_ID,
        slot: 'hero',
        masterKey: `originals/${MEDIA_ID}.jpg`,
        masterExtension: 'mp4',
      }),
    ).rejects.toThrow(/\[master-key-outside-video-master-prefix\]/)
    // The control: the real key passes the same check and fails later, on the slot, which proves the guard
    // above is about the prefix rather than about everything.
    await expect(
      runBuildVideoRenditions(storage, stubEncoder(), {
        mediaId: MEDIA_ID,
        slot: 'logo',
        masterKey,
        masterExtension: 'y4m',
      }),
    ).rejects.toThrow(/\[slot-has-no-video\]/)
  })

  it('refuses a master that is not in the bucket', async () => {
    await expect(
      runBuildVideoRenditions(storage, stubEncoder(), {
        mediaId: MEDIA_ID,
        slot: 'hero',
        masterKey: videoMasterKey('0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e99', 'y4m'),
        masterExtension: 'y4m',
      }),
    ).rejects.toThrow(/\[outbox-object-absent\]/)
  })
})
