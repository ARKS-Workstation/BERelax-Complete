/**
 * The fake media storage adapter: a visible local outbox, and no silent success.
 *
 * docs/12 §1 states the prohibition this file exists to honour — **a stub must never look like it
 * works**. The easy version of this class is `async put() {}`: it satisfies the type, every test passes,
 * and the first real deploy discovers that no derivative has ever been written. So this one writes real
 * bytes to a real directory, **reads them back and compares the digest**, and appends a line to
 * `puts.jsonl` so that every put is a thing a person can look at. A write it cannot verify throws.
 *
 * The outbox layout is the bucket layout, not a flattened one:
 *
 *     artifacts/media-outbox/private/<originals prefix>/<mediaId>.jpg
 *     artifacts/media-outbox/public/m/<mediaId>/<hash>/<slot>-<crop>-<width>.avif
 *     artifacts/media-outbox/puts.jsonl
 *
 * Mirroring the buckets is deliberate: the one failure worth catching before production is an original
 * written to the public bucket, and a flattened outbox would hide exactly that. The `.meta` sidecar
 * carries the content type and cache-control an object was stored with, because those are object
 * metadata in Spaces and a `head` that guessed them from the file extension would be asserting nothing.
 */

import type { Dirent } from 'node:fs'
import {
  appendFileSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { AppError } from '@berelax/shared'
import { sha256Hex } from '../hash.ts'
import {
  MEDIA_BUCKETS,
  type MediaBucket,
  type MediaStorage,
  type PutRequest,
  type StoredObject,
} from './port.ts'

/** Where the fake writes by default. Gitignored, and inspectable after any test or local run. */
export const DEFAULT_OUTBOX = 'artifacts/media-outbox'

/** The log every put appends to, so a fake upload leaves a trace even when nobody looks at the bytes. */
export const PUT_LOG = 'puts.jsonl'

const META_DIRECTORY = '.meta'

export interface FakeStorageOptions {
  /** Outbox root. Absolute, or relative to the process's working directory. */
  readonly outbox?: string
  /** Injected so a test's log lines are as fixed as everything else it asserts. */
  readonly now?: () => string
}

interface StoredMeta {
  readonly contentType: string
  readonly cacheControl: string
  readonly sha256: string
  readonly bytes: number
  readonly at: string
}

/**
 * A key is a key, not a path.
 *
 * `..` in an object key is legal in S3 and means nothing there; on a filesystem-backed fake it escapes
 * the outbox, and the fake is handed keys built from job data. The check belongs here rather than at
 * every call site.
 */
function assertSafeKey(key: string): void {
  const bad =
    key.length === 0 ||
    key.startsWith('/') ||
    key.split('/').some((segment) => segment === '..' || segment === '.' || segment === '')
  if (bad) {
    throw new AppError('validation', `[unsafe-object-key] '${key}' is not a relative object key`, {
      details: { key },
    })
  }
}

export function createFakeMediaStorage(options: FakeStorageOptions = {}): MediaStorage {
  const root = options.outbox ?? DEFAULT_OUTBOX
  const now = options.now ?? (() => new Date().toISOString())

  const objectPath = (bucket: MediaBucket, key: string): string => {
    assertSafeKey(key)
    return join(root, bucket, key)
  }
  const metaPath = (bucket: MediaBucket, key: string): string =>
    join(root, META_DIRECTORY, bucket, `${key}.json`)

  const readMeta = (bucket: MediaBucket, key: string): StoredMeta => {
    try {
      return JSON.parse(readFileSync(metaPath(bucket, key), 'utf8')) as StoredMeta
    } catch (cause) {
      // The object is on disk and its metadata is not. Reporting it as absent would make a half-written
      // outbox look like an empty one, which is the failure this adapter exists to refuse.
      throw new AppError(
        'invariant_violated',
        `[outbox-missing-metadata] ${bucket}/${key} is in the outbox with no stored metadata`,
        { cause, details: { bucket, key } },
      )
    }
  }

  return {
    kind: 'fake',
    outbox: root,

    async put(request: PutRequest): Promise<StoredObject> {
      const target = objectPath(request.bucket, request.key)
      const expected = sha256Hex(request.body)

      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, request.body)

      // The read-back. Without it this adapter reports success for a write the filesystem rejected, a
      // partial write, or a path that silently resolved somewhere else — and "the upload succeeded" is
      // the one thing a storage adapter must never say without evidence.
      const written = readFileSync(target)
      const actual = sha256Hex(written)
      if (actual !== expected || written.length !== request.body.length) {
        throw new AppError(
          'invariant_violated',
          `[outbox-write-not-verified] ${request.bucket}/${request.key} read back as ${written.length} ` +
            `bytes / ${actual} instead of ${request.body.length} bytes / ${expected}`,
          { details: { bucket: request.bucket, key: request.key, expected, actual } },
        )
      }

      const meta: StoredMeta = {
        contentType: request.contentType,
        cacheControl: request.cacheControl,
        sha256: actual,
        bytes: written.length,
        at: now(),
      }
      const metaTarget = metaPath(request.bucket, request.key)
      mkdirSync(dirname(metaTarget), { recursive: true })
      writeFileSync(metaTarget, `${JSON.stringify(meta)}\n`)

      mkdirSync(root, { recursive: true })
      appendFileSync(
        join(root, PUT_LOG),
        `${JSON.stringify({ bucket: request.bucket, key: request.key, ...meta })}\n`,
      )

      return {
        bucket: request.bucket,
        key: request.key,
        bytes: meta.bytes,
        sha256: meta.sha256,
        contentType: meta.contentType,
        cacheControl: meta.cacheControl,
      }
    },

    async head(location): Promise<StoredObject | undefined> {
      const target = objectPath(location.bucket, location.key)
      let size: number
      try {
        size = statSync(target).size
      } catch {
        return undefined
      }
      const meta = readMeta(location.bucket, location.key)
      if (meta.bytes !== size) {
        throw new AppError(
          'invariant_violated',
          `[outbox-size-drift] ${location.bucket}/${location.key} is ${size} bytes on disk and ` +
            `${meta.bytes} in its metadata — the object was replaced outside this adapter`,
          { details: { ...location, size, recorded: meta.bytes } },
        )
      }
      return {
        bucket: location.bucket,
        key: location.key,
        bytes: size,
        sha256: meta.sha256,
        contentType: meta.contentType,
        cacheControl: meta.cacheControl,
      }
    },

    async get(location): Promise<Uint8Array> {
      const target = objectPath(location.bucket, location.key)
      try {
        return readFileSync(target)
      } catch (cause) {
        throw new AppError(
          'not_found',
          `[outbox-object-absent] ${location.bucket}/${location.key} is not in the outbox`,
          { cause, details: { ...location } },
        )
      }
    },

    async list(bucket: MediaBucket): Promise<readonly string[]> {
      if (!MEDIA_BUCKETS.includes(bucket)) {
        throw new AppError('validation', `[unknown-bucket] '${bucket}' is not a media bucket`, {
          details: { bucket, buckets: MEDIA_BUCKETS },
        })
      }
      const base = join(root, bucket)
      const keys: string[] = []
      const walk = (directory: string): void => {
        let entries: Dirent[]
        try {
          entries = readdirSync(directory, { withFileTypes: true })
        } catch {
          return
        }
        for (const entry of entries) {
          const full = join(directory, entry.name)
          if (entry.isDirectory()) walk(full)
          // Object keys use `/` on every platform; a Windows outbox must not produce `a\b` keys.
          else keys.push(relative(base, full).split(sep).join('/'))
        }
      }
      walk(base)
      return keys.sort()
    },
  }
}
