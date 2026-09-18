import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createFakeMediaStorage,
  DERIVATIVE_PATH_PATTERN,
  type MediaStorage,
  originalKey,
  renditionSpecs,
  storeOriginal,
} from '@berelax/media'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { assertRegistry, cronRegistrations, JOB_REGISTRY } from '../registry.ts'
import { runJobBody } from '../testing/harness.ts'
import {
  BUILD_DERIVATIVES_JOB,
  createMediaStorageFor,
  runBuildDerivatives,
  setMediaStorage,
} from './build-derivatives.ts'

/**
 * The job, through the worker's own harness.
 *
 * Three things this file is for, and none of them is the pipeline itself — that is proved in
 * `packages/media/src/derivatives.itest.ts`.
 *
 * **It is a queue and not a cron.** `assertRegistry` requires an `agent_definition` on any job with a
 * `cron`, because a scheduled job nobody watches is what G-AGT-01 exists to remove. This one is announced
 * by the upload that produced the original, so it has neither — and that has to be asserted, because the
 * easy mistake is to add a `cron` "so it catches up", which would then need an agent nobody wrote.
 *
 * **It reads from the private bucket, and only from there.** The key arrives as job data.
 *
 * **It uses the injected clock.** A handler that read `Date.now()` itself would be untestable and would
 * also be the one job in the registry that did.
 */
const NOW = '2026-09-18T10:00:00.000Z'
const MEDIA_ID = '0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e1f'
/** The smallest real portrait in the library: 1066x1476, 58KB. A real original, and the cheapest one. */
const ORIGINAL = new URL('../../../../assets/media/team/team-14.jpg', import.meta.url).pathname

let outbox: string
let storage: MediaStorage
let key: string

beforeAll(async () => {
  outbox = mkdtempSync(join(tmpdir(), 'berelax-job-media-'))
  storage = createFakeMediaStorage({ outbox, now: () => NOW })
  key = await storeOriginal({
    mediaId: MEDIA_ID,
    extension: 'jpg',
    source: readFileSync(ORIGINAL),
    contentType: 'image/jpeg',
    storage,
  })
})

afterAll(() => {
  rmSync(outbox, { recursive: true, force: true })
})

/**
 * First in the file, deliberately.
 *
 * `setMediaStorage` is a module-level binding with no reset — the same shape as `setMaintenanceSql`, and
 * for the same reason: the registry has to be enumerable by `pnpm jobs` without a bucket. So the only
 * moment the "ran before an adapter was supplied" guard can be observed is before the first
 * `setMediaStorage` call, and a `describe` moved below this one would silently stop testing it.
 */
describe('before an adapter is supplied', () => {
  it('refuses to run rather than reporting a build it did not do', async () => {
    await expect(
      runJobBody(
        BUILD_DERIVATIVES_JOB,
        { mediaId: MEDIA_ID, slot: 'hero', originalKey: 'x' },
        {
          now: NOW,
        },
      ),
    ).rejects.toThrow(/setMediaStorage/)
  })
})

describe('the registry entry', () => {
  it('is a queue with no cron, and therefore no agent', () => {
    const declared = JOB_REGISTRY.find((job) => job.name === 'media.build-derivatives')
    expect(declared).toBeDefined()
    expect(declared?.cron).toBeUndefined()
    expect(declared?.agent).toBeUndefined()
    // The control: the registry does contain crons, and every one of them names an agent. So "no agent" is
    // a property of this job rather than of a registry where the field is never set.
    const crons = cronRegistrations()
    expect(crons.length).toBeGreaterThan(0)
    for (const cron of crons) {
      expect(cron.agent, cron.name).toBeDefined()
      expect(cron.name).not.toBe('media.build-derivatives')
    }
    // And the whole registry is still valid with this entry in it, which is the thing `pnpm jobs` asserts
    // statically and would fail on a cron with no agent.
    expect(() => assertRegistry(JOB_REGISTRY)).not.toThrow()
  })

  it('allows long enough for twenty-four encodes', () => {
    // The widest AVIF rung alone measures seven to eight seconds (docs/08 §8 budgets 2-8s per large
    // image). pg-boss reclaims a job at `expireInSeconds`, so a default of 60 would dead-letter every
    // build halfway through and retry it forever.
    expect(BUILD_DERIVATIVES_JOB.expireInSeconds).toBeGreaterThanOrEqual(600)
    expect(BUILD_DERIVATIVES_JOB.retryLimit).toBeGreaterThanOrEqual(1)
  })
})

describe('the storage flag', () => {
  it('defaults to a fake with a visible outbox, and refuses `real` loudly', () => {
    const fake = createMediaStorageFor('fake')
    expect(fake.kind).toBe('fake')
    expect(fake.outbox).toBeDefined()
    // docs/12 §1: no no-op that returns success. There is no Spaces adapter, so `real` is an error rather
    // than a silent fall back to writing nothing anybody will ever look for.
    expect(() => createMediaStorageFor('real')).toThrow(/\[no-real-media-storage-adapter\]/)
  })
})

describe('the handler', () => {
  it('builds the declared ladder from the private original and logs the injected instant', async () => {
    setMediaStorage(storage)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      await runJobBody(
        BUILD_DERIVATIVES_JOB,
        {
          mediaId: MEDIA_ID,
          slot: 'therapist-portrait',
          originalKey: key,
          focal: { x: 50, y: 16 },
        },
        { now: NOW },
      )
      const lines = log.mock.calls.map((call) => String(call[0]))
      expect(lines.some((line) => line.includes(NOW))).toBe(true)
      expect(lines.some((line) => line.includes('24 encoded, 0 reused'))).toBe(true)
    } finally {
      log.mockRestore()
    }

    const keys = await storage.list('public')
    expect(keys).toHaveLength(renditionSpecs().length)
    for (const stored of keys) {
      expect(`/${stored}`, stored).toMatch(DERIVATIVE_PATH_PATTERN)
      expect(stored).toContain(`m/${MEDIA_ID}/`)
    }
    // The original stayed where it was put, and nothing else went into the private bucket.
    expect(await storage.list('private')).toEqual([originalKey(MEDIA_ID, 'jpg')])
  }, 240_000)

  it('refuses a key that is not a private original', async () => {
    // The key arrives as job data. Without this, a queue message could ask the worker to publish an
    // arbitrary private object — a signed consent PDF, for instance — into the public bucket.
    await expect(
      runBuildDerivatives(storage, {
        mediaId: MEDIA_ID,
        slot: 'hero',
        originalKey: 'consent/signed-2026.pdf',
      }),
    ).rejects.toThrow(/\[original-key-outside-originals-prefix\]/)
    // The control: the real key is accepted by the same check.
    await expect(
      runBuildDerivatives(storage, { mediaId: MEDIA_ID, slot: 'logo', originalKey: key }),
    ).rejects.toThrow(/\[slot-is-never-cropped\]/)
  })

  it('refuses an original that is not in the bucket', async () => {
    await expect(
      runBuildDerivatives(storage, {
        mediaId: MEDIA_ID,
        slot: 'hero',
        originalKey: originalKey('0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e99', 'jpg'),
      }),
    ).rejects.toThrow(/\[outbox-object-absent\]/)
  })
})
