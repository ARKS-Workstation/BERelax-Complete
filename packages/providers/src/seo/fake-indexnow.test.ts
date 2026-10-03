import { describe, expect, it } from 'vitest'
import { createCallLog } from '../call-log.ts'
import { FailureScript } from '../failure.ts'
import {
  createFakeIndexNow,
  INDEXNOW_KEY_UNSET,
  indexNowIdempotencyKey,
  indexNowKeyIsUnset,
} from './fake-indexnow.ts'

const CLOCK = '2026-10-03T10:00:00.000Z'
const KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'

function provider(failures = new FailureScript()) {
  return createFakeIndexNow({
    log: createCallLog(() => CLOCK),
    failures,
    now: () => CLOCK,
    key: KEY,
  })
}

const submission = (urls: readonly string[]) => ({
  host: 'example.test',
  urls,
  idempotencyKey: indexNowIdempotencyKey(urls),
})

const ONE = ['https://example.test/treatments/x']
const TWO = ['https://example.test/treatments/x', 'https://example.test/treatments/y']

describe('a key is required, and a marker is not a key', () => {
  it('refuses to construct with the marker the setting holds while Y1-indexnow-key is open', () => {
    // The "never silently succeeds" half of the criterion, enforced at the one moment it can be. A fake
    // that accepted a marker would report pings that reach nobody for as long as nobody checked Bing.
    expect(() =>
      createFakeIndexNow({
        log: createCallLog(() => CLOCK),
        failures: new FailureScript(),
        now: () => CLOCK,
        key: INDEXNOW_KEY_UNSET,
      }),
    ).toThrow(/marker rather than a key/)
  })

  it('recognises a marker in TypeScript, before any database is reachable', () => {
    expect(indexNowKeyIsUnset(INDEXNOW_KEY_UNSET)).toBe(true)
    expect(indexNowKeyIsUnset('')).toBe(true)
    expect(indexNowKeyIsUnset('   ')).toBe(true)
    expect(indexNowKeyIsUnset('TBC')).toBe(true)
    // The control: a real key is not a marker, or the refusal above would refuse everything.
    expect(indexNowKeyIsUnset(KEY)).toBe(false)
  })
})

describe('idempotency is over the URL SET', () => {
  it('is the same key for the same set in any order', () => {
    expect(indexNowIdempotencyKey(TWO)).toBe(indexNowIdempotencyKey([...TWO].reverse()))
    expect(indexNowIdempotencyKey([...TWO, TWO[0] as string])).toBe(indexNowIdempotencyKey(TWO))
  })

  it('is a different key for a set that gained a URL, which is what a second publish is', () => {
    expect(indexNowIdempotencyKey(ONE)).not.toBe(indexNowIdempotencyKey(TWO))
  })

  it('sends once per set and records the repeat as deduplicated', async () => {
    const indexNow = provider()
    const first = await indexNow.submit(submission(TWO))
    const second = await indexNow.submit(submission(TWO))
    expect(first).toEqual({ kind: 'accepted', urlCount: 2, deduplicated: false })
    expect(second).toEqual({ kind: 'accepted', urlCount: 2, deduplicated: true })
    // BOTH calls are in the outbox. An outbox that recorded only the first could not answer "did we try
    // again?", which is the question a retried publish raises.
    const outbox = await indexNow.outbox()
    expect(outbox).toHaveLength(2)
    expect(outbox.filter((entry) => entry.outcome.kind === 'accepted')).toHaveLength(2)
  })

  it('submits again for a different set, even one that overlaps', async () => {
    const indexNow = provider()
    await indexNow.submit(submission(ONE))
    const second = await indexNow.submit(submission(TWO))
    expect(second).toEqual({ kind: 'accepted', urlCount: 2, deduplicated: false })
  })
})

describe('a rejection is a value, and it reaches the outbox', () => {
  it('refuses a URL that is not on the host', async () => {
    const indexNow = provider()
    const outcome = await indexNow.submit({
      host: 'example.test',
      urls: ['https://elsewhere.test/x'],
      idempotencyKey: 'k',
    })
    expect(outcome).toEqual({
      kind: 'rejected',
      reason: 'url_not_on_host',
      detail: '1 URL(s) are not on example.test: https://elsewhere.test/x',
    })
    expect((await indexNow.outbox())[0]?.outcome.kind).toBe('rejected')
  })

  it('records a thrown failure in the outbox before throwing', async () => {
    // "We never pinged" and "we pinged and it blew up" are different answers, and the outbox is what
    // distinguishes them. A fake that threw without recording would make them the same.
    const failures = new FailureScript()
    failures.failNext('timeout')
    const indexNow = provider(failures)
    await expect(indexNow.submit(submission(ONE))).rejects.toThrow()
    const outbox = await indexNow.outbox()
    expect(outbox).toHaveLength(1)
    expect(outbox[0]?.outcome.kind).toBe('rejected')
  })

  it('accepts a legitimate submission, which is the control for both rejections', async () => {
    const indexNow = provider()
    expect((await indexNow.submit(submission(ONE))).kind).toBe('accepted')
  })
})
