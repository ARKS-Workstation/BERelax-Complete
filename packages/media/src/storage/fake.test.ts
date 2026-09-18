import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sha256Hex } from '../hash.ts'
import { createFakeMediaStorage, PUT_LOG } from './fake.ts'
import { IMMUTABLE_CACHE_CONTROL, PRIVATE_CACHE_CONTROL } from './port.ts'

/**
 * docs/12 §1: a stub must never look like it works.
 *
 * So the assertions here are about evidence rather than about return values. A put leaves bytes at a path
 * a person can open and a line in a log a person can read; a put whose bytes cannot be read back throws;
 * and an object tampered with outside the adapter is reported rather than served.
 *
 * A real temporary directory, not a mocked filesystem. A mock would prove the mock works, and the whole
 * point of this adapter is that the write is real.
 */
const body = Buffer.from('derivative bytes, pretend these are AVIF')
const AT = '2026-09-18T10:00:00.000Z'

let outbox: string

beforeEach(() => {
  outbox = mkdtempSync(join(tmpdir(), 'berelax-media-'))
})

afterEach(() => {
  rmSync(outbox, { recursive: true, force: true })
})

const storage = () => createFakeMediaStorage({ outbox, now: () => AT })

describe('the fake media storage outbox', () => {
  it('writes real bytes to a visible path, mirroring the bucket layout', async () => {
    const store = storage()
    expect(store.kind).toBe('fake')
    expect(store.outbox).toBe(outbox)

    const receipt = await store.put({
      bucket: 'public',
      key: 'm/x/y/hero-mobile-414.avif',
      body,
      contentType: 'image/avif',
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    })

    const onDisk = join(outbox, 'public', 'm/x/y/hero-mobile-414.avif')
    expect(statSync(onDisk).size).toBe(body.length)
    expect(readFileSync(onDisk).equals(body)).toBe(true)
    expect(receipt).toEqual({
      bucket: 'public',
      key: 'm/x/y/hero-mobile-414.avif',
      bytes: body.length,
      sha256: sha256Hex(body),
      contentType: 'image/avif',
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    })
  })

  it('appends every put to a log a person can read', async () => {
    const store = storage()
    await store.put({
      bucket: 'private',
      key: 'originals/a.jpg',
      body,
      contentType: 'image/jpeg',
      cacheControl: PRIVATE_CACHE_CONTROL,
    })
    await store.put({
      bucket: 'public',
      key: 'm/x/y/hero-mobile-414.avif',
      body,
      contentType: 'image/avif',
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    })

    const lines = readFileSync(join(outbox, PUT_LOG), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    const entries = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(entries.map((entry) => entry['bucket'])).toEqual(['private', 'public'])
    expect(entries[0]?.['at']).toBe(AT)
    expect(entries[1]?.['cacheControl']).toBe(IMMUTABLE_CACHE_CONTROL)
  })

  it('keeps the two buckets apart', async () => {
    // The split is a security boundary: an original in the public bucket is a full-resolution photograph
    // of an employee whose photography consent is not on record. A flattened outbox would hide it.
    const store = storage()
    const key = 'same/key.bin'
    await store.put({
      bucket: 'private',
      key,
      body,
      contentType: 'application/octet-stream',
      cacheControl: PRIVATE_CACHE_CONTROL,
    })
    expect(await store.head({ bucket: 'public', key })).toBeUndefined()
    expect(await store.list('private')).toEqual([key])
    expect(await store.list('public')).toEqual([])
    expect(statSync(join(outbox, 'private', 'same', 'key.bin')).size).toBe(body.length)
  })

  it('reports an absent object as absent, and refuses to fetch one', async () => {
    const store = storage()
    expect(await store.head({ bucket: 'public', key: 'm/nothing.avif' })).toBeUndefined()
    await expect(store.get({ bucket: 'public', key: 'm/nothing.avif' })).rejects.toThrow(
      /\[outbox-object-absent\]/,
    )
  })

  it('notices an object changed behind its back', async () => {
    // The control for the read-back in `put`. Without a verification step there is nothing here to fail:
    // the adapter would report the recorded size for a file that is now a different size.
    const store = storage()
    const key = 'm/x/y/hero-mobile-414.avif'
    await store.put({
      bucket: 'public',
      key,
      body,
      contentType: 'image/avif',
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    })
    expect(await store.head({ bucket: 'public', key })).toBeDefined()

    truncateSync(join(outbox, 'public', key), 3)
    await expect(store.head({ bucket: 'public', key })).rejects.toThrow(/\[outbox-size-drift\]/)
  })

  it('refuses an object it cannot write, rather than reporting success', async () => {
    // The outbox root is a *file*, so no bucket directory can be created under it. The adapter must fail;
    // the version of this code that swallowed the error is the one docs/12 §1 prohibits by name.
    const blocked = join(outbox, 'not-a-directory')
    writeFileSync(blocked, 'x')
    const store = createFakeMediaStorage({ outbox: blocked, now: () => AT })
    await expect(
      store.put({
        bucket: 'public',
        key: 'm/x/y/hero-mobile-414.avif',
        body,
        contentType: 'image/avif',
        cacheControl: IMMUTABLE_CACHE_CONTROL,
      }),
    ).rejects.toThrow()
  })

  it('refuses a key that would escape the outbox', async () => {
    const store = storage()
    for (const key of ['../escape.bin', '/absolute.bin', 'a//b.bin', '', './here.bin']) {
      await expect(
        store.put({
          bucket: 'public',
          key,
          body,
          contentType: 'image/avif',
          cacheControl: IMMUTABLE_CACHE_CONTROL,
        }),
      ).rejects.toThrow(/\[unsafe-object-key\]/)
    }
    // The control: an ordinary nested key is accepted.
    await expect(
      store.put({
        bucket: 'public',
        key: 'a/b/c.bin',
        body,
        contentType: 'image/avif',
        cacheControl: IMMUTABLE_CACHE_CONTROL,
      }),
    ).resolves.toBeDefined()
  })

  it('refuses a bucket that is not one of the two', async () => {
    const store = storage()
    // Cast, because the type already forbids it — the runtime check is for a bucket name arriving as job
    // data or configuration, where the type system is not present.
    await expect(store.list('archive' as 'public')).rejects.toThrow(/\[unknown-bucket\]/)
  })

  it('reports an object whose metadata has gone missing', async () => {
    const store = storage()
    const key = 'm/x/y/hero-mobile-414.avif'
    await store.put({
      bucket: 'public',
      key,
      body,
      contentType: 'image/avif',
      cacheControl: IMMUTABLE_CACHE_CONTROL,
    })
    rmSync(join(outbox, '.meta', 'public', `${key}.json`))
    // Not `undefined`: a half-written outbox must not read as an empty one, because the derivative job
    // treats "absent" as "encode it again" and would then overwrite bytes it cannot account for.
    await expect(store.head({ bucket: 'public', key })).rejects.toThrow(
      /\[outbox-missing-metadata\]/,
    )
  })
})
