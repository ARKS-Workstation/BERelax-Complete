import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { loadConfig } from '@berelax/config'
import {
  createDocumentUrlSigner,
  createFakeMediaStorage,
  type DocumentSigningKeyRing,
  type DocumentUrlSigner,
  type MediaStorage,
} from '@berelax/media/storage'
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

/**
 * The key ring every private-document link is signed and verified under, or `undefined` (W-SYS-14).
 *
 * `undefined` rather than a throw, and the distinction is the whole point: a deployment with no
 * `DOCUMENT_URL_SIGNING_SECRET` must still serve every image on the site, so the absence cannot be fatal
 * here. It becomes fatal at the moment somebody asks for a document, where the store answers
 * `[document-signing-not-configured]` by name — no document rather than a document with no authorisation.
 * Throwing from this function would take the derivative origin down over a missing DOCUMENT key, which is
 * `[no-real-media-storage-adapter]`'s failure mode inverted.
 *
 * The retired slot is read and never written to: `createDocumentUrlSigner` signs with the current key and
 * consults both to verify, so a rotation is a one-way door rather than a state where two keys are current.
 */
export function documentSigningKeyRing(): DocumentSigningKeyRing | undefined {
  const config = loadConfig()
  const secret = config.DOCUMENT_URL_SIGNING_SECRET
  if (secret === undefined || secret.trim() === '') return undefined
  const retiredSecret = config.DOCUMENT_URL_SIGNING_SECRET_PREVIOUS
  return {
    current: {
      // `v1` when no label is set. A version label is only ever compared byte for byte, so a default is
      // safe in a way a default SECRET would not be — and a deployment that set a key and forgot the label
      // must produce working links rather than fail to boot over a string nobody reads.
      version: config.DOCUMENT_URL_SIGNING_SECRET_VERSION ?? 'v1',
      secret,
    },
    ...(retiredSecret === undefined || retiredSecret.trim() === ''
      ? {}
      : {
          retired: {
            version: config.DOCUMENT_URL_SIGNING_SECRET_PREVIOUS_VERSION ?? 'v0',
            secret: retiredSecret,
          },
        }),
  }
}

let cachedSigner: DocumentUrlSigner | undefined

/** The signer, or `undefined` when no key is configured. Cached with the adapter, for the same reason. */
export function appDocumentUrlSigner(): DocumentUrlSigner | undefined {
  if (cachedSigner !== undefined) return cachedSigner
  const ring = documentSigningKeyRing()
  if (ring === undefined) return undefined
  cachedSigner = createDocumentUrlSigner(ring)
  return cachedSigner
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
  const signer = appDocumentUrlSigner()
  cached = createFakeMediaStorage({
    outbox: mediaOutboxRoot(),
    // Spread rather than `signer: appDocumentUrlSigner()`, because `exactOptionalPropertyTypes` refuses an
    // explicit `undefined` for an optional property — and the adapter's own refusal already distinguishes
    // "no key configured" from "the store refused", so passing one would say the same thing twice.
    ...(signer === undefined ? {} : { signer }),
  })
  return cached
}
