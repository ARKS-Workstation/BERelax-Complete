import {
  buildVideoRenditions,
  createFfmpegEncoder,
  isVideoMasterKey,
  type MediaStorage,
  resolveFfmpeg,
  type VideoBuildResult,
  type VideoEncoder,
} from '@berelax/media'
import { AppError } from '@berelax/shared'
import type { JobContext, JobDefinition } from '../job.ts'

/**
 * W-SYS-06 — the hero video renditions, as a queue with no schedule.
 *
 * **Why no `cron`.** Identical reasoning to `media.build-derivatives`: a rendition build is announced by
 * the upload that wrote the master into the private bucket. A cron here would be a poller looking for work
 * an enqueue already announced, and it would either run constantly doing nothing or leave a new hero
 * unpublished until it next fired. `assertRegistry` therefore requires no `agent_definition` — it demands
 * one only for a job with a `cron`, because the thing G-AGT-01 watches is a schedule nobody is looking at.
 * Here the caller is the request that accepted the file, and the caller is what is being watched.
 *
 * **Why an hour of `expireInSeconds`.** Four renditions, all at `-preset veryslow`, two of them x265. On
 * the reference numbers in docs/08 §8 (2–8 seconds of AVIF *per image rung*) a four-second 1080p loop at
 * x265 veryslow is minutes per rendition, not seconds. pg-boss reclaims a job at `expireInSeconds` and
 * retries it, so a ten-minute ceiling would dead-letter every build part-way through and then do it again.
 *
 * **What happens with no ffmpeg.** It fails, by name, with the directories it searched. There is no
 * fallback encoder and no skip: W-SYS-05's `[no-real-media-storage-adapter]` set the precedent, and the
 * failure this avoids is a job that completes, logs four renditions and has written nothing anybody will
 * ever look for.
 */
export interface BuildVideoRenditionsData {
  /** The media row this master belongs to. A lower-case UUID; it is in every rendition URL. */
  readonly mediaId: string
  /** The slot. Only `hero` has a video ladder; anything else is refused by name. */
  readonly slot: string
  /** Private-bucket key of the master. Must be under the video-master prefix. */
  readonly masterKey: string
  /** The master's container extension, so ffmpeg reads it as what it is. */
  readonly masterExtension: string
  /** Focal point percentages for the 4:5 crop. Centre when absent. */
  readonly focal?: { readonly x: number; readonly y: number }
}

/**
 * Storage and encoder, supplied at boot.
 *
 * Module-level bindings for the same structural reason `setMediaStorage` and `setMaintenanceSql` are:
 * `JOB_REGISTRY` is a module constant that `pnpm jobs` imports and enumerates *without* a database, a
 * bucket or an encoder, and making a handler's dependencies constructor arguments would turn the registry
 * into a function — at which point "every job this system runs is declared in one array" stops being
 * checkable statically.
 *
 * The encoder is separate from the storage adapter and is **lazily** resolved, because resolving it runs
 * two subprocesses and reads a licence string. A worker that has no video work to do should not refuse to
 * boot over a missing ffmpeg; a worker that is handed video work must refuse to pretend.
 */
let storage: MediaStorage | undefined
let encoder: VideoEncoder | undefined
let encoderFactory: (() => Promise<VideoEncoder>) | undefined

export function setVideoRenditionStorage(adapter: MediaStorage): void {
  storage = adapter
}

/**
 * Overrides how the encoder is obtained.
 *
 * The one seam in this job, and it exists for a single reason: the orchestration worth testing — the head
 * check that makes a second run free, the probe that reads the stored bytes back, the hard stop, the bucket
 * split and the cache headers — must be exercisable without a two-hour encode. The default is the real
 * ffmpeg and there is no other default, so a test that forgets to set this gets `[ffmpeg-not-available]`
 * rather than a stub.
 */
export function setVideoEncoderFactory(factory: () => Promise<VideoEncoder>): void {
  encoderFactory = factory
  encoder = undefined
}

/** The default factory: find ffmpeg, check what it is, and refuse anything unexpected. */
async function defaultEncoderFactory(): Promise<VideoEncoder> {
  return createFfmpegEncoder(await resolveFfmpeg())
}

async function currentEncoder(): Promise<VideoEncoder> {
  // Resolved once per process, then reused, so a build of four renditions does not run `ffmpeg -encoders`
  // four times. Deliberately *not* cached across a `setVideoEncoderFactory` call, which resets it.
  if (encoder === undefined) encoder = await (encoderFactory ?? defaultEncoderFactory)()
  return encoder
}

export async function runBuildVideoRenditions(
  adapter: MediaStorage,
  videoEncoder: VideoEncoder,
  data: BuildVideoRenditionsData,
): Promise<VideoBuildResult> {
  if (!isVideoMasterKey(data.masterKey)) {
    // The key arrives as job data and the job reads from the private bucket. A key from anywhere else is
    // either a bug or a queue message asking this worker to publish an arbitrary private object — a signed
    // consent PDF, or a full-resolution photograph of a member of staff whose photography consent is not
    // on record (Y12-consent-photo).
    throw new AppError(
      'validation',
      `[master-key-outside-video-master-prefix] '${data.masterKey}' is not a private video master key`,
      { details: { masterKey: data.masterKey } },
    )
  }
  const master = await adapter.get({ bucket: 'private', key: data.masterKey })
  return await buildVideoRenditions({
    mediaId: data.mediaId,
    slot: data.slot,
    master,
    masterExtension: data.masterExtension,
    ...(data.focal === undefined ? {} : { focal: data.focal }),
    storage: adapter,
    encoder: videoEncoder,
  })
}

async function handler(data: BuildVideoRenditionsData, context: JobContext): Promise<void> {
  if (storage === undefined) {
    throw new AppError(
      'invariant_violated',
      'The video rendition job ran before setVideoRenditionStorage() supplied an adapter. run.ts calls ' +
        'it before startWorkers().',
    )
  }
  const result = await runBuildVideoRenditions(storage, await currentEncoder(), data)
  console.log(
    `media.build-video-renditions ${result.mediaId} ${result.slot}@${result.contentHash}: ` +
      `${result.encoded} encoded, ${result.reused} reused, ${result.outputs.length} rendition(s) via ` +
      // The master's provenance is in the log line, not only in a document. There is no hero footage
      // (Y12-hero-video), so a run against the marked stand-in must say so — a log line that read the same
      // either way would be the only record of a pipeline that has never seen the real thing.
      `${result.encoder}${result.master.standIn ? ' from a STAND-IN master (Y12-hero-video)' : ''} at ` +
      `${context.now()}`,
  )
  for (const breach of result.overBudget) {
    // docs/08 §8 puts the per-crop budget in the CI layer and the 2MB hard stop in this one, so this is a
    // warning here and a build failure in `pnpm budgets`. It carries the measured number either way.
    console.warn(`media.build-video-renditions ${result.mediaId}: ${breach}`)
  }
}

export const BUILD_VIDEO_RENDITIONS_JOB: JobDefinition<BuildVideoRenditionsData> = {
  name: 'media.build-video-renditions',
  purpose:
    'Builds the four hero video renditions docs/08 §6 permits from one private master — H.264 High and ' +
    'HEVC hvc1, at the 16:9 desktop and 4:5 mobile crops — ping-ponged into a seamless loop, faststart, ' +
    'probed out of their own bytes, and written to content-addressed immutable paths in the public ' +
    'bucket. No VP9, no HLS. Triggered by an upload, so it has no schedule.',
  retryLimit: 3,
  retryDelaySeconds: 120,
  retryBackoff: true,
  // See the file header: four `veryslow` encodes, two of them x265.
  expireInSeconds: 3600,
  handler,
}
