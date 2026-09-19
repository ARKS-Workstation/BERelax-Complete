import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadConfig } from '@berelax/config'
import { createFakeMediaStorage, type MediaStorage } from '@berelax/media/storage'
import { AppError } from '@berelax/shared'

/**
 * The bucket this application reads, and the one thing it refuses to guess.
 *
 * Two routes need objects out of the media buckets: the derivative origin (`app/m/...`) serves the public
 * ones, and the breakpoint preview measures them. Both go through this, so there is one answer to "which
 * adapter am I talking to" in the app — the same shape `apps/worker`'s `createMediaStorageFor` gives the
 * job, and deliberately the same refusal.
 *
 * `MEDIA_STORAGE=real` throws `[no-real-media-storage-adapter]` rather than falling back to the fake. A
 * fallback here would be worse than in the worker: the worker would report uploads that never happened,
 * and this would serve **404s for every image on the site** while the preview showed an editor a complete
 * ladder. There is no DigitalOcean Spaces adapter yet (W-SYS-05's gap, seen from the serving side).
 *
 * ## Why the outbox is anchored on the repository root
 *
 * `DEFAULT_OUTBOX` is `artifacts/media-outbox`, relative to the working directory — and this application's
 * working directory is `apps/web` under `next start` and the repository root under `vitest`. Left relative,
 * the derivative job and the route that serves its output would write and read two different directories,
 * and the symptom would be a preview that reports every rung missing on a machine where the job ran. So
 * the root is found the way `app/(en)/(dev)/kitchen-sink/portraits.ts` finds the media library: walk up
 * until `assets/media/manifest.json` is there.
 */
const MEDIA_LIBRARY_MARKER = join('assets', 'media', 'manifest.json')

/** Walks up from the working directory to the repository root. */
export function repositoryRoot(): string {
  let directory = process.cwd()
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(directory, MEDIA_LIBRARY_MARKER))) return directory
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  throw new AppError(
    'invariant_violated',
    `[repository-root-not-found] no ${MEDIA_LIBRARY_MARKER} above ${process.cwd()}, so the media ` +
      'outbox cannot be located. The fake adapter writes a path relative to the working directory, and ' +
      'guessing it would mean serving 404s for every derivative the job built.',
  )
}

/** Where the fake adapter's buckets live, as one absolute path every consumer agrees on. */
export function mediaOutboxRoot(): string {
  return join(repositoryRoot(), 'artifacts', 'media-outbox')
}

let cached: MediaStorage | undefined

export function appMediaStorage(): MediaStorage {
  if (cached !== undefined) return cached
  const mode = loadConfig().MEDIA_STORAGE
  if (mode !== 'fake') {
    throw new AppError(
      'invariant_violated',
      '[no-real-media-storage-adapter] MEDIA_STORAGE=real is configured and no DigitalOcean Spaces ' +
        'adapter is wired yet. Set MEDIA_STORAGE=fake, or implement the adapter against the port in ' +
        'packages/media/src/storage/port.ts. Falling back to the fake here would serve a 404 for every ' +
        'derivative while reporting the ladder as complete.',
      { details: { mode } },
    )
  }
  cached = createFakeMediaStorage({ outbox: mediaOutboxRoot() })
  return cached
}
