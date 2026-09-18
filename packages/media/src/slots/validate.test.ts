import { AppError } from '@berelax/shared'
import { describe, expect, it } from 'vitest'
import { MEDIA_SLOT_LIST, SLOT_RATIO_TOLERANCE, SLOT_REGISTRY } from './registry.ts'
import {
  assertSlotImagesPublishable,
  assertUploadAllowed,
  declaredCropRect,
  publicationRefusals,
  ratioDeviation,
  type SlotViolationRule,
  type UploadMeasurement,
  validateUpload,
} from './validate.ts'

const MIB = 1024 * 1024

/** A correct hero upload. Every case below is this with one thing wrong. */
const GOOD_HERO: UploadMeasurement = {
  slot: 'hero',
  mimeType: 'image/jpeg',
  byteLength: 2 * MIB,
  width: 1920,
  height: 1080,
  filename: 'photos/hero-team.jpg',
}

const rulesFor = (measurement: UploadMeasurement): readonly SlotViolationRule[] =>
  validateUpload(measurement).map((violation) => violation.rule)

/**
 * The table the acceptance asks for, one row per constraint.
 *
 * Each row states the rule that must fire, because "rejected" is also what a typo in a field name
 * produces. `expected: []` rows are the controls: the same shape, legitimately, which is what says the
 * rejections came from the constraint rather than from the validator refusing everything (ADR 0003).
 */
const TABLE: readonly {
  readonly name: string
  readonly upload: UploadMeasurement
  readonly expected: readonly SlotViolationRule[]
}[] = [
  { name: 'a correct 16:9 hero', upload: GOOD_HERO, expected: [] },
  {
    name: 'a WebP master',
    upload: { ...GOOD_HERO, mimeType: 'image/webp' },
    expected: ['slot-mime-not-allowed'],
  },
  {
    name: 'an SVG in a photographic slot',
    upload: { ...GOOD_HERO, mimeType: 'image/svg+xml' },
    expected: ['slot-mime-not-allowed'],
  },
  {
    name: 'a PNG, which is allowed',
    upload: { ...GOOD_HERO, mimeType: 'image/png' },
    expected: [],
  },
  {
    name: 'a file one byte over the cap',
    upload: { ...GOOD_HERO, byteLength: SLOT_REGISTRY.hero.maxBytes + 1 },
    expected: ['slot-over-maximum-bytes'],
  },
  {
    name: 'a file exactly at the cap',
    upload: { ...GOOD_HERO, byteLength: SLOT_REGISTRY.hero.maxBytes },
    expected: [],
  },
  {
    name: 'a frame narrower than the widest rung needs',
    upload: { ...GOOD_HERO, width: 1024, height: 576 },
    expected: ['slot-below-minimum-dimensions'],
  },
  {
    name: 'a frame exactly at the minimum',
    upload: { ...GOOD_HERO, width: 1280, height: 720 },
    expected: [],
  },
  {
    // 1920x1073 is 0.65% away from 16:9 — just outside the tolerance — and says nothing about its subject.
    name: 'a ratio 0.65% out with no focal point',
    upload: { ...GOOD_HERO, height: 1073 },
    expected: ['slot-ratio-out-of-tolerance'],
  },
  {
    // 1920x1076 is 0.37% away: inside the tolerance, which is what admits two export tools disagreeing.
    name: 'a ratio 0.37% out, inside the tolerance',
    upload: { ...GOOD_HERO, height: 1076 },
    expected: [],
  },
  {
    // The real photos/spa-01.jpg: 2.50 against 16:9's 1.778, 41% off, and it declares a focal point —
    // which is what says the crop is a decision rather than a guess. It crops to 1410x793.
    name: 'a real 2.50 interior with a declared focal point',
    upload: { ...GOOD_HERO, width: 1983, height: 793, focal: { x: 50, y: 45 } },
    expected: [],
  },
  {
    // A tall frame with a focal point. The focal point says where the subject is; it cannot add pixels, and
    // 700 wide is under the hero minimum however the window is placed.
    name: 'a tall frame narrower than the minimum, focal point and all',
    upload: { ...GOOD_HERO, width: 700, height: 3000, focal: { x: 50, y: 20 } },
    expected: ['slot-below-minimum-dimensions'],
  },
  {
    name: 'a focal point outside the frame, on both axes',
    upload: { ...GOOD_HERO, width: 1983, height: 793, focal: { x: 150, y: -4 } },
    expected: ['slot-focal-point-out-of-range', 'slot-focal-point-out-of-range'],
  },
  {
    // A wordmark. No ratio, so no ratio rule can fire whatever shape it is, and a much smaller cap.
    name: 'a 950x467 wordmark',
    upload: {
      slot: 'logo',
      mimeType: 'image/png',
      byteLength: 105_384,
      width: 950,
      height: 467,
      filename: 'logo/be-relax-logo-dark.png',
    },
    expected: [],
  },
  {
    name: 'a wordmark over its 512KB cap',
    upload: {
      slot: 'logo',
      mimeType: 'image/png',
      byteLength: 600 * 1024,
      width: 950,
      height: 467,
    },
    expected: ['slot-over-maximum-bytes'],
  },
]

describe('the declared constraints, as a table', () => {
  it.each(TABLE)('$name', ({ upload, expected }) => {
    expect([...rulesFor(upload)].sort()).toEqual([...expected].sort())
  })

  it('has a control for every rule it exercises', () => {
    // The vacuity check on the table itself. A table of nothing but failures proves a validator that
    // rejects everything, and a table of nothing but passes proves one that accepts everything.
    expect(TABLE.some((row) => row.expected.length === 0)).toBe(true)
    expect(TABLE.filter((row) => row.expected.length === 0).length).toBeGreaterThanOrEqual(6)
    expect(TABLE.filter((row) => row.expected.length > 0).length).toBeGreaterThanOrEqual(6)
  })
})

describe('the field-level message', () => {
  it('names the constraint, the measured value and the field it belongs against', () => {
    const [violation] = validateUpload({ ...GOOD_HERO, byteLength: 12 * MIB })
    expect(violation?.rule).toBe('slot-over-maximum-bytes')
    expect(violation?.field).toBe('file')
    // The constraint, as the registry declares it.
    expect(violation?.constraint).toContain(String(SLOT_REGISTRY.hero.maxBytes))
    // And the value that was measured, to the byte.
    expect(violation?.measured).toContain(String(12 * MIB))
    expect(violation?.message).toContain('[slot-over-maximum-bytes]')
    expect(violation?.message).toContain('12.00MB')
  })

  it('names the measured pixel count and the ratio, not just “invalid image”', () => {
    const [violation] = validateUpload({ ...GOOD_HERO, height: 1073 })
    expect(violation?.measured).toContain('1920x1073')
    expect(violation?.measured).toContain('1.789')
    expect(violation?.constraint).toContain('16:9')
    expect(violation?.constraint).toContain('0.5%')
  })

  it('names the measured mime type rather than saying the file is invalid', () => {
    const [violation] = validateUpload({ ...GOOD_HERO, mimeType: 'image/heic' })
    expect(violation?.rule).toBe('slot-mime-not-allowed')
    expect(violation?.measured).toContain('image/heic')
    expect(violation?.constraint).toContain('image/jpeg and image/png')
  })
})

describe('the rule that is deliberately not written', () => {
  /**
   * The crop window never needs a rule of its own, and this is why.
   *
   * `minHeight` is `minWidth` scaled by the slot's own ratio, so the window taken at that ratio out of any
   * source clearing `minWidth` x `minHeight` clears them as well — at every focal point, in both
   * orientations. A `slot-crop-below-minimum-dimensions` rule would therefore be a check no fixture could
   * ever trip: green for ever, and indistinguishable from a rule that had stopped matching.
   *
   * So the implication is asserted instead, which is the thing actually worth knowing, and the second half
   * is the control: a source that fails the minimum produces a crop that fails it too, so the minimum is
   * doing real work rather than being trivially satisfiable.
   */
  const FOCAL_SWEEP = [0, 16, 45, 50, 84, 100] as const

  it('is implied: any source clearing the minimum crops to something that clears it', () => {
    for (const slot of MEDIA_SLOT_LIST) {
      if (slot.ratio === null) continue
      const sources = [
        { width: slot.minWidth, height: slot.minHeight },
        { width: slot.minWidth, height: slot.minHeight * 6 },
        { width: slot.minWidth * 7, height: slot.minHeight },
        { width: slot.minWidth + 1, height: slot.minHeight + 1 },
        { width: slot.minWidth * 3, height: slot.minHeight * 2 },
      ]
      for (const source of sources) {
        for (const x of FOCAL_SWEEP) {
          for (const y of FOCAL_SWEEP) {
            const rect = declaredCropRect(
              { ...GOOD_HERO, slot: slot.name, ...source, focal: { x, y } },
              slot,
            )
            expect(
              rect.width >= slot.minWidth && rect.height >= slot.minHeight,
              `${slot.name} ${source.width}x${source.height} @ ${x},${y} -> ${rect.width}x${rect.height}`,
            ).toBe(true)
          }
        }
      }
    }
  })

  it('and the minimum is not vacuous: a source under it crops to something under it', () => {
    for (const slot of MEDIA_SLOT_LIST) {
      if (slot.ratio === null) continue
      const rect = declaredCropRect(
        {
          ...GOOD_HERO,
          slot: slot.name,
          width: slot.minWidth - 1,
          height: slot.minHeight - 1,
          focal: { x: 50, y: 50 },
        },
        slot,
      )
      expect(rect.width < slot.minWidth || rect.height < slot.minHeight, slot.name).toBe(true)
    }
  })
})

describe('the 12MB portrait hero', () => {
  const TWELVE_MB: UploadMeasurement = {
    slot: 'hero',
    mimeType: 'image/jpeg',
    byteLength: 12 * MIB,
    // A phone camera's portrait frame, which is how a 12MB file arrives.
    width: 3024,
    height: 4032,
    filename: 'IMG_2044.JPG',
  }

  it('is rejected outright', () => {
    expect(rulesFor(TWELVE_MB)).toContain('slot-over-maximum-bytes')
    expect(() => assertUploadAllowed(TWELVE_MB)).toThrow(AppError)
  })

  it('is never silently resized', () => {
    // There is no branch in this module that fixes an upload, and this is the assertion that says so: a
    // violation carries a rule, a field, the constraint, the measurement and a message — and nothing that
    // could be a corrected file, a suggested width or an "accepted with changes" flag. A validator that
    // grew one would fail here.
    for (const violation of validateUpload(TWELVE_MB)) {
      expect(Object.keys(violation).sort()).toEqual([
        'constraint',
        'field',
        'measured',
        'message',
        'rule',
      ])
    }
    // And the refusal is a refusal: nothing is returned that a caller could store.
    expect(() => assertUploadAllowed(TWELVE_MB)).toThrow(/\[slot-over-maximum-bytes\]/)
  })

  it('is refused for its weight even when everything else about it is right', () => {
    // The control that isolates the byte cap from the ratio rule: the same weight in a correctly shaped,
    // correctly sized frame is still refused, and the same frame under the cap is accepted.
    expect(rulesFor({ ...GOOD_HERO, byteLength: 12 * MIB })).toEqual(['slot-over-maximum-bytes'])
    expect(rulesFor({ ...GOOD_HERO, byteLength: 7 * MIB })).toEqual([])
  })
})

describe('the helpers the rules are built on', () => {
  it('measures ratio deviation as a proportion of the target', () => {
    expect(ratioDeviation(1920, 1080, 16 / 9)).toBeCloseTo(0, 10)
    expect(ratioDeviation(1600, 1000, 16 / 9)).toBeCloseTo(0.1, 3)
    expect(SLOT_RATIO_TOLERANCE).toBe(0.005)
  })

  it('takes the crop window with the same function the derivative job uses', () => {
    // Crop before resize (docs/08 §6): the window is taken at the slot's ratio around the focal point and
    // then clamped inside the frame, which is what `cropRectFor` does for the job.
    const rect = declaredCropRect(
      { ...GOOD_HERO, width: 1672, height: 941, focal: { x: 50, y: 45 } },
      SLOT_REGISTRY.hero,
    )
    expect(rect).toEqual({ left: 0, top: 0, width: 1672, height: 941 })
    // The 4:5 window out of the same frame is narrower, and the focal point decides where it sits.
    const portraitCrop = declaredCropRect(
      { ...GOOD_HERO, width: 1672, height: 941, focal: { x: 25, y: 50 } },
      SLOT_REGISTRY['therapist-portrait'],
    )
    expect(portraitCrop.width).toBe(753)
    expect(portraitCrop.height).toBe(941)
    expect(portraitCrop.left).toBe(42)
  })

  it('refuses a slot nobody declared', () => {
    expect(() => validateUpload({ ...GOOD_HERO, slot: 'carousel' })).toThrow(/\[unknown-slot\]/)
  })
})

describe('publication', () => {
  const GOOD_ALT = 'Therapist warming aromatherapy oil between her palms before a back massage'

  it('refuses a page whose slot image has junk alt text', () => {
    const refusals = publicationRefusals([{ slot: 'hero', alt: 'image' }])
    expect(refusals.map((refusal) => refusal.rule)).toEqual(['media-slot-alt-fails-validation'])
    expect(refusals[0]?.message).toContain('alt-is-boilerplate')
  })

  it('refuses a hero over docs/08 §8’s poster budget, with the measured weight in the error', () => {
    const refusals = publicationRefusals([
      { slot: 'hero', alt: GOOD_ALT, servedBytes: { mobile: 120 * 1024, desktop: 160 * 1024 } },
    ])
    expect(refusals.map((refusal) => refusal.rule)).toEqual(['media-slot-over-byte-budget'])
    expect(refusals[0]?.measuredBytes).toBe(120 * 1024)
    expect(refusals[0]?.message).toContain('122880 bytes')
    expect(refusals[0]?.message).toContain('97280 bytes')
    expect(() =>
      assertSlotImagesPublishable([
        { slot: 'hero', alt: GOOD_ALT, servedBytes: { mobile: 120 * 1024, desktop: 160 * 1024 } },
      ]),
    ).toThrow(/\[media-slot-over-byte-budget\]/)
  })

  it('allows a page whose slot images are described and inside budget', () => {
    // The control. Both halves have to pass something, or the gate is "refuse every publish".
    expect(
      publicationRefusals([
        { slot: 'hero', alt: GOOD_ALT, servedBytes: { mobile: 90 * 1024, desktop: 165 * 1024 } },
        { slot: 'testimonial-background', alt: '', decorative: true },
      ]),
    ).toEqual([])
  })

  it('does not invent a budget for a slot docs/08 does not give one for', () => {
    // A gallery tile with no stated budget passes on weight and is still checked on alt text. Making one
    // up would put a number nobody derived into a refusal an editor has to act on; the page-level
    // ≤1.9MB/≤3.2MB ceiling is a property of a rendered page and belongs to W-SITE-10.
    expect(
      publicationRefusals([
        { slot: 'gallery', alt: GOOD_ALT, servedBytes: { mobile: 9 * MIB, desktop: 9 * MIB } },
      ]),
    ).toEqual([])
    expect(
      publicationRefusals([
        { slot: 'gallery', alt: 'photo', servedBytes: { mobile: 1024, desktop: 1024 } },
      ]).map((refusal) => refusal.rule),
    ).toEqual(['media-slot-alt-fails-validation'])
  })
})
