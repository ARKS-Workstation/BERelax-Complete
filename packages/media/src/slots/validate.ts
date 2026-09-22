/**
 * The declared constraints, enforced against a measured upload.
 *
 * Every refusal names the rule, the constraint the slot declares and the value that was measured, because
 * the person reading it is an editor with a photograph and no idea why it was rejected. "Invalid image" is
 * the message that makes somebody try the same file four times.
 *
 * ## Refused, never resized
 *
 * There is no branch in this module that fixes an upload. A 12MB hero is refused; it is not downsampled to
 * fit, and it is not accepted-and-then-reduced. Both of those publish a photograph nobody approved at a
 * quality nobody chose, and the second does it after telling the editor the upload succeeded — the
 * silent-success failure docs/12 §1 prohibits. `validateUpload` returns violations and nothing else: its
 * return type has no room for a corrected file.
 *
 * ## Why the ratio rule needs a focal point rather than a wider tolerance
 *
 * docs/08 §6 gives every photographic slot a ratio, and the acceptance for this unit puts a ±0.5%
 * tolerance on it. Taken alone that would refuse almost the entire real library: 20 of the 23 assets in a
 * slot that declares a ratio are outside it, because the staff portraits run from 0.461 to 0.799 against
 * the 4:5 slot's 0.800. They are not mistakes — they are full-length photographs of people, and
 * `assets/media/README.md` measures them.
 *
 * What makes the difference between those and a genuine mistake is whether anybody has said where the
 * subject is. A source at the declared ratio needs no answer. A source at a different ratio is going to be
 * cropped, and a centre crop of a full-length portrait is a torso — so it is refused **unless a focal
 * point is declared**, and then the ratio is free.
 *
 * There is deliberately no third rule measuring the crop window. The obvious one — "the window at the
 * declared ratio must itself meet the minimum dimensions" — cannot fire: `minHeight` is `minWidth` scaled
 * by the slot's own ratio, so the window taken out of any source that clears `minWidth` x `minHeight`
 * clears them too, at every focal point. Writing that rule anyway would put a check in the file that no
 * fixture could ever trip, which is the shape ADR 0003 is about. It is asserted as the implication it
 * actually is, over every slot and a sweep of focal points, in `validate.test.ts`.
 */
import { AppError } from '@berelax/shared'
import { type CropRect, cropRectFor } from '../ladders.ts'
import { altViolations } from './alt-filter.ts'
import { type MediaSlot, mediaSlot, SLOT_RATIO_TOLERANCE } from './registry.ts'

/** Focal point percentages, as `assets/media/manifest.json` records them and Payload stores them. */
export interface FocalPercent {
  readonly x: number
  readonly y: number
}

export interface UploadMeasurement {
  readonly slot: string
  readonly mimeType: string
  /** The original's size in bytes, as measured — never as declared by the client. */
  readonly byteLength: number
  readonly width: number
  readonly height: number
  /** Where the subject is, if anybody has said. Absent means "nobody has". */
  readonly focal?: FocalPercent | undefined
  /** Only for the message, so a rejection can be traced back to a file. */
  readonly filename?: string | undefined
}

export const SLOT_VIOLATION_RULES = [
  'slot-mime-not-allowed',
  'slot-over-maximum-bytes',
  'slot-below-minimum-dimensions',
  'slot-ratio-out-of-tolerance',
  'slot-focal-point-out-of-range',
] as const

export type SlotViolationRule = (typeof SLOT_VIOLATION_RULES)[number]

export interface SlotViolation {
  readonly rule: SlotViolationRule
  /** The admin field the message belongs against. */
  readonly field: 'file' | 'slot' | 'focalX' | 'focalY'
  readonly constraint: string
  readonly measured: string
  readonly message: string
}

function violation(
  rule: SlotViolationRule,
  field: SlotViolation['field'],
  constraint: string,
  measured: string,
  why: string,
): SlotViolation {
  return {
    rule,
    field,
    constraint,
    measured,
    message: `[${rule}] ${constraint} ${measured}. ${why}`,
  }
}

/** Bytes as a figure a person can check against a file listing, with the exact count kept. */
function bytes(count: number): string {
  const mib = count / (1024 * 1024)
  return mib >= 0.1 ? `${count} bytes (${mib.toFixed(2)}MB)` : `${count} bytes`
}

/** The declared ratio as a decimal, for a message. `null` slots never reach this. */
function ratioOf(slot: MediaSlot): number {
  const ratio = slot.ratio
  if (ratio === null) {
    throw new AppError(
      'invariant_violated',
      `[slot-declares-no-ratio] slot '${slot.name}' has no ratio to measure against`,
    )
  }
  return ratio[0] / ratio[1]
}

/** How far a native ratio sits from a target, as a proportion of the target. */
export function ratioDeviation(width: number, height: number, target: number): number {
  return Math.abs(width / height - target) / target
}

/**
 * The crop window at the slot's **declared** ratio, around the focal point.
 *
 * One of the two windows the job takes, not the only one: the ladders are global, so every cropped slot is
 * also built at the other crop (see the note on `ratio` in `registry.ts`). This is the one whose shape the
 * slot declares, which is the shape an upload is measured against and the shape a single-image component
 * reserves — and the same `cropRectFor` the job calls, deliberately: a validator that computed the window
 * its own way would approve uploads the pipeline then crops differently, which is the class of bug where
 * the check and the thing checked have drifted and both look right.
 */
export function declaredCropRect(measurement: UploadMeasurement, slot: MediaSlot): CropRect {
  const ratio = slot.ratio
  if (ratio === null) {
    return { left: 0, top: 0, width: measurement.width, height: measurement.height }
  }
  // `cropRectFor` takes a named crop, and the two named crops are the ladders' 4:5 and 16:9 — which are
  // exactly the two ratios the slots declare, so the slot's ratio selects the crop rather than adding a
  // third code path. A slot declaring some other ratio would fail the registry test that pins this.
  const crop = ratio[0] / ratio[1] < 1 ? 'mobile' : 'desktop'
  return cropRectFor(
    { width: measurement.width, height: measurement.height },
    crop,
    measurement.focal ?? { x: 50, y: 50 },
  )
}

/** Every constraint the upload breaks. Empty means it may be stored. */
export function validateUpload(measurement: UploadMeasurement): readonly SlotViolation[] {
  const slot = mediaSlot(measurement.slot)
  const out: SlotViolation[] = []
  const where = measurement.filename === undefined ? '' : ` (${measurement.filename})`

  if (!(slot.mimeTypes as readonly string[]).includes(measurement.mimeType)) {
    out.push(
      violation(
        'slot-mime-not-allowed',
        'file',
        `Slot “${slot.label}” accepts ${slot.mimeTypes.join(' and ')}.`,
        `this file is ${measurement.mimeType}${where}`,
        'The original is the master every derivative is built from. A lossy delivery format re-encoded to ' +
          'AVIF compounds two lossy passes in exactly the low-contrast gradients this photography is made ' +
          'of, and an SVG is a document that can carry script rather than an image that can be measured.',
      ),
    )
  }

  if (measurement.byteLength > slot.maxBytes) {
    out.push(
      violation(
        'slot-over-maximum-bytes',
        'file',
        `Slot “${slot.label}” accepts at most ${bytes(slot.maxBytes)}.`,
        `this file is ${bytes(measurement.byteLength)}${where}`,
        'It is refused rather than resized: a resize here would publish a photograph at a size and ' +
          'quality nobody chose, and would report the upload as successful while doing it. Export it ' +
          'smaller and upload again.',
      ),
    )
  }

  if (measurement.width < slot.minWidth || measurement.height < slot.minHeight) {
    out.push(
      violation(
        'slot-below-minimum-dimensions',
        'file',
        `Slot “${slot.label}” needs at least ${slot.minWidth}x${slot.minHeight} pixels.`,
        `this file is ${measurement.width}x${measurement.height}${where}`,
        'Every rung of the ladder is produced from this one file, so a source below the minimum is ' +
          'upscaled at the widest width — which looks soft on exactly the large screens it was meant for.',
      ),
    )
  }

  const focal = measurement.focal
  if (focal !== undefined) {
    for (const [axis, value] of [
      ['focalX', focal.x],
      ['focalY', focal.y],
    ] as const) {
      if (!Number.isFinite(value) || value < 0 || value > 100) {
        out.push(
          violation(
            'slot-focal-point-out-of-range',
            axis,
            'A focal point is a percentage of the frame, from 0 to 100.',
            `${axis} is ${String(value)}`,
            'Percentages and not pixels, so the same point survives every rung of the ladder and every ' +
              'replacement of the original at a different size.',
          ),
        )
      }
    }
  }

  if (slot.ratio !== null) {
    const target = ratioOf(slot)
    const deviation = ratioDeviation(measurement.width, measurement.height, target)
    if (deviation > SLOT_RATIO_TOLERANCE && focal === undefined) {
      out.push(
        violation(
          'slot-ratio-out-of-tolerance',
          'file',
          `Slot “${slot.label}” declares ${slot.ratio[0]}:${slot.ratio[1]} (${target.toFixed(3)}), ` +
            `and a source more than ${(SLOT_RATIO_TOLERANCE * 100).toFixed(1)}% away from it must say ` +
            'where its subject is.',
          `this file is ${measurement.width}x${measurement.height} (${(measurement.width / measurement.height).toFixed(3)}, ` +
            `${(deviation * 100).toFixed(1)}% off) and declares no focal point${where}`,
          'A source at a different ratio is going to be cropped, and a centre crop is a guess: the ' +
            'nineteen real portraits are full-length with the face in the top fifth, so centring them ' +
            'produces a row of torsos. Set the focal point and the crop is defined.',
        ),
      )
    }
  }

  return out
}

/** Refuses an upload that breaks any declared constraint, naming every rule it broke. */
export function assertUploadAllowed(measurement: UploadMeasurement): void {
  const violations = validateUpload(measurement)
  if (violations.length === 0) return
  throw new AppError('validation', violations.map((entry) => entry.message).join('\n'), {
    userFacing: true,
    details: {
      slot: measurement.slot,
      rules: violations.map((entry) => entry.rule),
      violations: violations.length,
    },
  })
}

// ---------------------------------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------------------------------

export const PUBLICATION_REFUSAL_RULES = [
  'media-slot-alt-fails-validation',
  'media-slot-over-byte-budget',
] as const

export type PublicationRefusalRule = (typeof PUBLICATION_REFUSAL_RULES)[number]

export interface PublicationRefusal {
  readonly rule: PublicationRefusalRule
  readonly slot: string
  /** The weight that was measured, in bytes. Zero for an alt refusal, which is not about weight. */
  readonly measuredBytes: number
  readonly message: string
}

/**
 * One slot image on a page that is about to be published.
 *
 * `servedBytes` is the weight of the derivative that will actually be downloaded, per crop — not the
 * original's. The original never reaches a browser, so its size is an upload question and this is a
 * publication one.
 */
export interface SlotImageForPublication {
  readonly slot: string
  readonly alt: string | null | undefined
  readonly decorative?: boolean
  readonly filename?: string | undefined
  readonly context?: readonly string[]
  readonly servedBytes?: { readonly mobile: number; readonly desktop: number } | undefined
}

/**
 * Why a publish attempt must be refused, with the measured weight in the message.
 *
 * Exported for the publication control plane (W-SITE-10), which owns the draft → lint → approval →
 * published state machine and the synthetic weight check. This function is the media half of its
 * pre-publication gate: it takes the slot images of a page and answers whether any of them would reach the
 * public with alt text that fails validation or with a derivative over the slot's stated budget.
 */
export function publicationRefusals(
  images: readonly SlotImageForPublication[],
): readonly PublicationRefusal[] {
  const out: PublicationRefusal[] = []

  for (const image of images) {
    const slot = mediaSlot(image.slot)
    const altFailures = altViolations({
      slot,
      alt: image.alt,
      ...(image.decorative === undefined ? {} : { decorative: image.decorative }),
      filename: image.filename,
      ...(image.context === undefined ? {} : { context: image.context }),
    })
    if (altFailures.length > 0) {
      out.push({
        rule: 'media-slot-alt-fails-validation',
        slot: slot.name,
        measuredBytes: 0,
        message:
          `[media-slot-alt-fails-validation] slot '${slot.name}' cannot be published: ` +
          `${altFailures.map((failure) => failure.rule).join(', ')}. ` +
          'Alt text is checked before publication and not only on upload, because a row can be edited ' +
          'after it was accepted.',
      })
    }

    const budget = slot.publishedBudgetBytes
    const served = image.servedBytes
    if (budget !== null && served !== undefined) {
      for (const crop of ['mobile', 'desktop'] as const) {
        if (served[crop] > budget[crop]) {
          out.push({
            rule: 'media-slot-over-byte-budget',
            slot: slot.name,
            measuredBytes: served[crop],
            message:
              `[media-slot-over-byte-budget] slot '${slot.name}' ${crop} derivative measures ` +
              `${bytes(served[crop])} against the ${bytes(budget[crop])} docs/08 §8 allows. Refused ` +
              'before publication rather than a week later in field data: an editor’s oversized ' +
              'photograph is the most common way a performance budget is breached.',
          })
        }
      }
    }
  }

  return out
}

/** Refuses a publish attempt, with the measured weight in the error. */
export function assertSlotImagesPublishable(images: readonly SlotImageForPublication[]): void {
  const refusals = publicationRefusals(images)
  if (refusals.length === 0) return
  throw new AppError('validation', refusals.map((refusal) => refusal.message).join('\n'), {
    userFacing: true,
    details: {
      rules: refusals.map((refusal) => refusal.rule),
      slots: refusals.map((refusal) => refusal.slot),
      measuredBytes: refusals.map((refusal) => refusal.measuredBytes),
    },
  })
}
