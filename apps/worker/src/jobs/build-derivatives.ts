import {
  buildDerivatives,
  createFakeMediaStorage,
  type DerivativeBuildResult,
  isOriginalKey,
  type MediaStorage,
} from '@berelax/media'
import { AppError } from '@berelax/shared'
import type { JobContext, JobDefinition } from '../job.ts'

/**
 * W-SYS-05 — the derivative build, as a queue with no schedule.
 *
 * **Why no `cron`.** A derivative build is triggered by an upload: an admin replaces a therapist
 * portrait, the request writes the original to the private bucket and enqueues this. A cron here would
 * be a poller looking for work that an enqueue already announced, and it would either run constantly
 * doing nothing or leave a new photograph unpublished until it next fired. That also means no
 * `agent_definition` is required — `assertRegistry` demands one only for a job with a `cron`, because the
 * thing G-AGT-01 watches is a schedule nobody is looking at. Here the caller is the request that accepted
 * the file, and the caller is what is being watched.
 *
 * **Why the whole ladder, every time.** Twenty-four encodes is two to eight seconds of AVIF per large
 * rung (docs/08 §8 budgets it explicitly), so `expireInSeconds` is generous. The alternative — encode the
 * rungs somebody asked for — needs a transform origin, and DigitalOcean Spaces has none.
 */
export interface BuildDerivativesData {
  /** The media row this original belongs to. A lower-case UUID; it is in every derivative URL. */
  readonly mediaId: string
  /** A slot that declares an aspect ratio. `logo` is refused: a wordmark is not cropped. */
  readonly slot: string
  /** Private-bucket key of the original. Must be under the originals prefix. */
  readonly originalKey: string
  /** Focal point percentages from the media manifest. Centre when absent. */
  readonly focal?: { readonly x: number; readonly y: number }
}

/**
 * The storage adapter, supplied at boot.
 *
 * A module-level binding for the same reason `setMaintenanceSql` is one: `JOB_REGISTRY` is a module
 * constant that `pnpm jobs` imports and enumerates *without* a database or a bucket, and making a
 * handler's dependencies constructor arguments would turn the registry into a function — at which point
 * "every job this system runs is declared in one array" stops being checkable statically.
 */
let storage: MediaStorage | undefined

export function setMediaStorage(adapter: MediaStorage): void {
  storage = adapter
}

/**
 * The adapter for a configured mode.
 *
 * docs/12 §1.3: the fake is the default and the switch is configuration, never a code change. `real`
 * throws, loudly and by name, because there is no Spaces adapter yet — the alternative, quietly falling
 * back to the fake, is the exact failure docs/12 §1 prohibits: a production deploy that reports every
 * upload as successful and has written nothing to a bucket.
 */
export function createMediaStorageFor(mode: 'fake' | 'real'): MediaStorage {
  if (mode === 'fake') return createFakeMediaStorage()
  throw new AppError(
    'invariant_violated',
    '[no-real-media-storage-adapter] MEDIA_STORAGE=real is configured and no DigitalOcean Spaces ' +
      'adapter is wired yet. Set MEDIA_STORAGE=fake, or implement the adapter against the port in ' +
      'packages/media/src/storage/port.ts. Falling back to the fake here would report uploads that ' +
      'never happened.',
  )
}

export async function runBuildDerivatives(
  adapter: MediaStorage,
  data: BuildDerivativesData,
): Promise<DerivativeBuildResult> {
  if (!isOriginalKey(data.originalKey)) {
    // The job reads from the private bucket, and the key arrives as job data. A key from anywhere else is
    // either a bug or a queue message asking this worker to publish an arbitrary private object.
    throw new AppError(
      'validation',
      `[original-key-outside-originals-prefix] '${data.originalKey}' is not a private original key`,
      { details: { originalKey: data.originalKey } },
    )
  }
  const source = await adapter.get({ bucket: 'private', key: data.originalKey })
  return await buildDerivatives({
    mediaId: data.mediaId,
    slot: data.slot,
    source,
    ...(data.focal === undefined ? {} : { focal: data.focal }),
    storage: adapter,
  })
}

async function handler(data: BuildDerivativesData, context: JobContext): Promise<void> {
  if (storage === undefined) {
    throw new AppError(
      'invariant_violated',
      'The derivative job ran before setMediaStorage() supplied an adapter. run.ts calls it before ' +
        'startWorkers().',
    )
  }
  const result = await runBuildDerivatives(storage, data)
  console.log(
    `media.build-derivatives ${result.mediaId} ${result.slot}@${result.contentHash}: ` +
      `${result.encoded} encoded, ${result.reused} reused, ${result.outputs.length} derivative(s) ` +
      `at ${context.now()}`,
  )
}

export const BUILD_DERIVATIVES_JOB: JobDefinition<BuildDerivativesData> = {
  name: 'media.build-derivatives',
  purpose:
    'Builds the two art-directed ladders for one uploaded original — 4:5 for phones, 16:9 above them, ' +
    'AVIF/WebP/JPEG at four rungs each — into content-addressed immutable paths in the public bucket. ' +
    'Triggered by an upload, so it has no schedule.',
  retryLimit: 3,
  retryDelaySeconds: 60,
  retryBackoff: true,
  // Twenty-four encodes, and the widest AVIF rung alone measures 7-8 seconds on this hardware. Ten
  // minutes is headroom for a slower box and a larger original; a job still running past that is stuck
  // rather than slow, and reclaiming it is the right answer.
  expireInSeconds: 600,
  handler,
}
