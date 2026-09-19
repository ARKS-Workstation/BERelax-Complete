import { isAppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import {
  assertLadderComplete,
  bytesOfRung,
  maxServedBytes,
  ORIGINAL_EXTENSIONS,
  resolveDerivativeSet,
  rungVerdicts,
} from './derivative-set.ts'
import { contentAddress } from './hash.ts'
import { CROP_NAMES, CROPS, FORMATS } from './ladders.ts'
import { mediaSlot } from './slots/registry.ts'
import {
  type MediaBucket,
  type MediaStorage,
  type PutRequest,
  publicKeyFor,
  type StoredObject,
} from './storage/port.ts'
import { derivativePath, originalKey } from './url.ts'

/**
 * W-SYS-10 — what the preview reads out of the bucket.
 *
 * The claim under test is the one the acceptance criterion insists on: **the per-rung weight is the size of
 * the object, not an estimate.** So the storage here is an in-memory port implementation whose `head`
 * returns sizes this test chose, and every assertion is that the numbers on the way out are those numbers.
 * An implementation that computed a weight from the rung's pixel count would pass a test that only checked
 * the weight was plausible; none of these are.
 *
 * No `sharp` and no filesystem: the encoder is `derivatives.itest.ts`'s subject. This is the reader.
 */
const MEDIA_ID = '0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e1f'
const OTHER_ID = '0191f2c4-6b3a-7c1d-9e04-5a7b8c9d0e20'

/** Source bytes whose content address the paths must carry. Deliberately not an image: nothing decodes it. */
const SOURCE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
const HASH = contentAddress(SOURCE)

interface FakeOptions {
  /** Rungs to leave out of the public bucket, as `${crop}-${width}-${format}`. */
  readonly omit?: readonly string[]
  /** Bytes per rung. A function so a test can make a rung heavy without touching the others. */
  readonly bytesFor?: (crop: string, width: number, format: string) => number
  readonly originalExtension?: string
}

/**
 * An in-memory `MediaStorage`.
 *
 * Written here rather than reusing the filesystem fake because these tests are about *byte counts a `head`
 * reports*, and the fake's counts come from files it wrote — which would make the assertions about sharp's
 * output rather than about this module.
 */
function fakeStorage(options: FakeOptions = {}): MediaStorage {
  const omit = new Set(options.omit ?? [])
  const bytesFor = options.bytesFor ?? ((_crop, width) => width * 10)
  const objects = new Map<string, StoredObject>()

  const put = (bucket: MediaBucket, key: string, bytes: number): void => {
    objects.set(`${bucket}:${key}`, {
      bucket,
      key,
      bytes,
      sha256: 'f'.repeat(64),
      contentType: 'application/octet-stream',
      cacheControl: 'public',
    })
  }

  put('private', originalKey(MEDIA_ID, options.originalExtension ?? 'jpg'), SOURCE.length)
  for (const crop of CROP_NAMES) {
    for (const width of CROPS[crop].widths) {
      for (const format of FORMATS) {
        if (omit.has(`${crop}-${width}-${format}`)) continue
        const path = derivativePath({
          mediaId: MEDIA_ID,
          contentHash: HASH,
          slot: 'hero',
          crop,
          width,
          format,
        })
        put('public', publicKeyFor(path), bytesFor(crop, width, format))
      }
    }
  }

  return {
    kind: 'fake',
    outbox: undefined,
    async put(request: PutRequest): Promise<StoredObject> {
      put(request.bucket, request.key, request.body.length)
      return objects.get(`${request.bucket}:${request.key}`) as StoredObject
    },
    async head(location): Promise<StoredObject | undefined> {
      return objects.get(`${location.bucket}:${location.key}`)
    },
    async get(location): Promise<Uint8Array> {
      if (!objects.has(`${location.bucket}:${location.key}`)) {
        throw new Error(`[outbox-object-absent] ${location.bucket}/${location.key}`)
      }
      return SOURCE
    },
    async list(): Promise<readonly string[]> {
      return [...objects.keys()]
    },
  }
}

describe('resolveDerivativeSet', () => {
  it('addresses the ladder by the CURRENT original and reports every rung', async () => {
    const set = await resolveDerivativeSet(fakeStorage(), MEDIA_ID, 'hero')
    expect(set).toBeDefined()
    if (set === undefined) return
    // The content address is the source's, which is what makes a replaced original a different set of URLs
    // rather than the same URLs with new bytes — the reason a year of `immutable` is safe.
    expect(set.contentHash).toBe(HASH)
    expect(set.sourceBytes).toBe(SOURCE.length)
    expect(set.outputs).toHaveLength(24)
    expect(set.missing).toEqual([])
    for (const output of set.outputs) {
      expect(output.path, output.path).toContain(`/${HASH}/`)
      // The number came from `head`, not from arithmetic on the rung. `bytesFor` is `width * 10`, which no
      // plausible estimator would produce.
      expect(output.bytes, output.path).toBe(output.width * 10)
    }
  })

  it('reports a rung the bucket does not hold instead of inventing its URL', async () => {
    const set = await resolveDerivativeSet(
      fakeStorage({ omit: ['desktop-2560-avif'] }),
      MEDIA_ID,
      'hero',
    )
    expect(set?.outputs).toHaveLength(23)
    expect(set?.missing).toEqual([
      derivativePath({
        mediaId: MEDIA_ID,
        contentHash: HASH,
        slot: 'hero',
        crop: 'desktop',
        width: 2560,
        format: 'avif',
      }),
    ])
    // And that is a refusal with a name, because a rung missing from a srcset is a 404 the browser resolves
    // by rendering nothing, on the widest screens only.
    try {
      assertLadderComplete(set as never)
      expect.unreachable('an incomplete ladder must not be publishable')
    } catch (error) {
      expect(isAppError(error) && error.message).toContain('[derivative-ladder-incomplete]')
      expect(isAppError(error) && error.message).toContain('hero-desktop-2560.avif')
    }
    // The control: a complete ladder passes.
    const complete = await resolveDerivativeSet(fakeStorage(), MEDIA_ID, 'hero')
    expect(() => assertLadderComplete(complete as never)).not.toThrow()
  })

  it('answers undefined when nothing has been uploaded, rather than an empty ladder', async () => {
    // The normal state of a media row until `media.build-derivatives` has run. Undefined and not an empty
    // set, so a caller cannot mistake "no original" for "no derivatives of the original there is".
    expect(await resolveDerivativeSet(fakeStorage(), OTHER_ID, 'hero')).toBeUndefined()
  })

  it('finds a PNG original as readily as a JPEG one', async () => {
    expect(ORIGINAL_EXTENSIONS).toContain('png')
    const set = await resolveDerivativeSet(
      fakeStorage({ originalExtension: 'png' }),
      MEDIA_ID,
      'hero',
    )
    expect(set?.contentHash).toBe(HASH)
  })

  it('refuses a slot with no ladder and an id that is not a media id', async () => {
    await expect(resolveDerivativeSet(fakeStorage(), MEDIA_ID, 'logo')).rejects.toThrow(
      /\[slot-is-never-cropped]/,
    )
    await expect(resolveDerivativeSet(fakeStorage(), 'not-a-uuid', 'hero')).rejects.toThrow(
      /\[invalid-media-id]/,
    )
  })
})

describe('bytesOfRung and maxServedBytes', () => {
  it('finds one rung, and reports the heaviest AVIF per crop', async () => {
    const set = await resolveDerivativeSet(fakeStorage(), MEDIA_ID, 'hero')
    if (set === undefined) throw new Error('no set')
    expect(bytesOfRung(set, 'mobile', 414, 'avif')).toBe(4140)
    expect(bytesOfRung(set, 'mobile', 500, 'avif')).toBeUndefined()
    // AVIF, because that is the first `<source>` and the format docs/08 §8's figure is written for. The JPEG
    // fallback of the same rung is far heavier and must not be what a budget is measured against.
    expect(maxServedBytes(set)).toEqual({ mobile: 10_800, desktop: 25_600 })
  })

  it('is the MAXIMUM, not the widest, so a non-monotonic source cannot slip past a budget', async () => {
    // A fine texture can cost more at 1440 than at 1920 once the resampler has smoothed it. If this read the
    // widest rung, the 1440 rung below would be over budget on the preview and absent from the refusal.
    const set = await resolveDerivativeSet(
      fakeStorage({
        bytesFor: (crop, width) => (crop === 'desktop' && width === 1440 ? 999_999 : width * 10),
      }),
      MEDIA_ID,
      'hero',
    )
    if (set === undefined) throw new Error('no set')
    expect(maxServedBytes(set)?.desktop).toBe(999_999)
  })

  it('answers undefined when a crop has no AVIF rung at all', async () => {
    const omit = CROPS.mobile.widths.map((width) => `mobile-${width}-avif`)
    const set = await resolveDerivativeSet(fakeStorage({ omit }), MEDIA_ID, 'hero')
    if (set === undefined) throw new Error('no set')
    // Undefined rather than zero: zero would be "within every budget", which is the wrong answer in the
    // direction that lets a page publish.
    expect(maxServedBytes(set)).toBeUndefined()
  })
})

describe('rungVerdicts', () => {
  it('marks a rung over its crop budget, and leaves the rest within', async () => {
    const budget = mediaSlot('hero').publishedBudgetBytes
    expect(budget, 'the hero slot must declare a published budget').not.toBeNull()
    if (budget === null) return
    const set = await resolveDerivativeSet(
      fakeStorage({
        // One rung over the mobile budget by a single byte, everything else far under. A single byte,
        // because an off-by-one in the comparison is the failure a generous fixture cannot see.
        bytesFor: (crop, width) =>
          crop === 'mobile' && width === 1080 ? budget.mobile + 1 : 1_000,
      }),
      MEDIA_ID,
      'hero',
    )
    if (set === undefined) throw new Error('no set')
    const verdicts = rungVerdicts(set, budget)
    expect(verdicts).toHaveLength(8)
    const over = verdicts.filter((verdict) => verdict.overBudget)
    expect(over.map((verdict) => `${verdict.rendition.crop}-${verdict.rendition.width}`)).toEqual([
      'mobile-1080',
    ])
    expect(over[0]?.rendition.bytes).toBe(budget.mobile + 1)
    expect(over[0]?.budgetBytes).toBe(budget.mobile)
    // The control on the comparison boundary: exactly at the budget is NOT over.
    const exact = await resolveDerivativeSet(
      fakeStorage({ bytesFor: (crop) => (crop === 'mobile' ? budget.mobile : 1_000) }),
      MEDIA_ID,
      'hero',
    )
    if (exact === undefined) throw new Error('no set')
    expect(rungVerdicts(exact, budget).some((verdict) => verdict.overBudget)).toBe(false)
  })

  it('never reports over budget for a slot docs/08 states no budget for', async () => {
    // `publishedBudgetBytes` is null for every slot but the hero, and null means "no figure was derived",
    // not "unlimited". A verdict that treated null as zero would flag every gallery tile.
    const set = await resolveDerivativeSet(
      fakeStorage({ bytesFor: () => 50_000_000 }),
      MEDIA_ID,
      'hero',
    )
    if (set === undefined) throw new Error('no set')
    const verdicts = rungVerdicts(set, null)
    expect(verdicts.every((verdict) => verdict.budgetBytes === null)).toBe(true)
    expect(verdicts.some((verdict) => verdict.overBudget)).toBe(false)
    // And the control: with the hero's real budget those same 50MB rungs are all over.
    expect(
      rungVerdicts(set, mediaSlot('hero').publishedBudgetBytes).every(
        (verdict) => verdict.overBudget,
      ),
    ).toBe(true)
  })

  it('reports one format, so a JPEG fallback is not measured against an AVIF budget', async () => {
    const set = await resolveDerivativeSet(fakeStorage(), MEDIA_ID, 'hero')
    if (set === undefined) throw new Error('no set')
    expect(rungVerdicts(set, null).every((verdict) => verdict.rendition.format === 'avif')).toBe(
      true,
    )
    expect(
      rungVerdicts(set, null, 'jpg').every((verdict) => verdict.rendition.format === 'jpg'),
    ).toBe(true)
  })
})
