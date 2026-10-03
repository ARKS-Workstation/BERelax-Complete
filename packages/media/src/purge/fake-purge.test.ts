import { describe, expect, it } from 'vitest'
import { createFakePurge, purgeIdempotencyKey } from './fake-purge.ts'

const CLOCK = '2026-10-03T10:00:00.000Z'
const port = () => createFakePurge({ now: () => CLOCK })
const request = (paths: readonly string[]) => ({
  paths,
  reason: 'service published',
  idempotencyKey: purgeIdempotencyKey(paths),
})

describe('a purge is accepted, never completed', () => {
  it('answers accepted with the path count', async () => {
    // No CDN promises completion at the moment of the call, so a port that answered "purged" would make
    // the pipeline claim something no CDN does — and a test built on it would pass while a stale page was
    // still being served.
    const purge = port()
    expect(await purge.purge(request(['/treatments/x', '/ar/treatments/x']))).toEqual({
      kind: 'accepted',
      pathCount: 2,
      deduplicated: false,
    })
  })

  it('deduplicates a repeat of the same path set', async () => {
    const purge = port()
    await purge.purge(request(['/a']))
    expect(await purge.purge(request(['/a']))).toEqual({
      kind: 'accepted',
      pathCount: 1,
      deduplicated: true,
    })
    // Both in the outbox: the count is a measurement of attempts, and the outcome is what says whether
    // anything was sent.
    expect(await purge.outbox()).toHaveLength(2)
  })

  it('refuses a full URL, which most CDNs accept and then match nothing', async () => {
    const purge = port()
    const outcome = await purge.purge(request(['https://example.test/a']))
    expect(outcome.kind).toBe('rejected')
    expect((await purge.outbox())[0]?.outcome.kind).toBe('rejected')
  })

  it('refuses a purge with no paths', async () => {
    expect((await port().purge(request([]))).kind).toBe('rejected')
  })

  it('records purgeAll with its reason, in the same sequence', async () => {
    // One outbox, not two: a reader asking "what was purged on Friday evening" must not have to join two
    // lists, and the reason is the only thing that will explain a whole-zone purge six weeks later.
    const purge = port()
    await purge.purge(request(['/a']))
    await purge.purgeAll('relaunch')
    const outbox = await purge.outbox()
    expect(outbox).toHaveLength(2)
    expect([...(outbox[1]?.paths ?? [])]).toEqual(['/*'])
    expect(outbox[1]?.reason).toBe('relaunch')
  })
})

describe('the idempotency key is over the path SET', () => {
  it('is order- and duplicate-independent', () => {
    expect(purgeIdempotencyKey(['/a', '/b'])).toBe(purgeIdempotencyKey(['/b', '/a', '/a']))
  })

  it('changes when the set does', () => {
    expect(purgeIdempotencyKey(['/a'])).not.toBe(purgeIdempotencyKey(['/a', '/b']))
  })
})
