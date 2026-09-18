/**
 * The named slot registry: every media slot this site has, declared once.
 *
 * docs/08 §6 names five — hero, therapist portrait, service card, gallery, testimonial background —
 * "each declaring aspect ratio, minimum dimensions, maximum file size and **required alt text**". This
 * is that declaration, and it is the only one: the derivative ladders, the upload validator, the
 * alt-text filter, the placeholder, the `aspect-ratio` in every component's stylesheet and the slot
 * segment of every derivative URL all read it.
 *
 * ## Why one list rather than five agreeing lists
 *
 * A slot's ratio appears in at least four places that are not next to each other: the crop the worker
 * takes, the `aspect-ratio` the card reserves, the placeholder the page paints before the photograph
 * lands, and the manifest the media library is measured against. Four copies of `4 / 5` is three copies
 * that can be wrong, and the symptom of any one of them being wrong is not an error — it is a card that
 * reserves the wrong box and reflows when the image arrives, which is a CLS regression nobody attributes
 * to a number in a stylesheet. `scripts/check-media.mjs` therefore refuses a literal aspect ratio in any
 * component (`[aspect-ratio-must-come-from-the-slot-registry]`), and that rule only has somewhere to
 * send you because this file exists.
 *
 * ## Pure data
 *
 * No `sharp`, no `node:*`, no I/O — so `@berelax/media/slots` is importable from a browser bundle and
 * from `packages/ui`, which is what lets a component read a ratio instead of restating it.
 */
import { AppError } from '@berelax/shared'

/**
 * Every slot, in the order docs/08 §6 lists them, with `logo` last.
 *
 * `logo` is here and is *not* one of the five: a wordmark is not a photograph. It has no declared
 * ratio, it is never cropped, and it is in the registry because it is a real slot that real files
 * occupy in `assets/media/manifest.json` — leaving it out would mean a second, smaller list somewhere
 * for the one slot that behaves differently, which is how a special case stops being checked.
 */
export const MEDIA_SLOT_NAMES = [
  'hero',
  'therapist-portrait',
  'service-card',
  'gallery',
  'testimonial-background',
  'logo',
] as const

export type MediaSlotName = (typeof MEDIA_SLOT_NAMES)[number]

/** The five docs/08 §6 names. Held separately so widening the list above cannot quietly narrow this. */
export const EDITABLE_SLOT_NAMES = [
  'hero',
  'therapist-portrait',
  'service-card',
  'gallery',
  'testimonial-background',
] as const satisfies readonly MediaSlotName[]

/**
 * How far an upload's native ratio may sit from its slot's declared ratio before it needs a focal point.
 *
 * ±0.5%, which is tight on purpose: at 16:9 it is about nine pixels on a 1920-wide frame, so it admits a
 * rounding difference between two export tools and nothing else. It is not a crop tolerance — a source
 * that really is a different shape is not nearly the right shape, it is a different photograph, and the
 * question "where is the subject?" has to be answered before it can be cropped. See `validate.ts`.
 */
export const SLOT_RATIO_TOLERANCE = 0.005

/**
 * The mime types an original may arrive as.
 *
 * JPEG and PNG, and deliberately not four others:
 *
 *   - **WebP and AVIF** are lossy delivery formats. A master in one of them is re-encoded to AVIF by the
 *     derivative job, and compounding two lossy passes shows first in low-contrast gradients — which is
 *     what this photography is almost entirely made of (docs/08 §6 on colour management).
 *   - **SVG** is not an image, it is a document that may carry script and external references. Serving an
 *     uploaded one same-origin is stored XSS, and nothing in this repository sanitises one.
 *   - **HEIC** has no decoder in the shipped libvips build, so accepting it would mean an upload that is
 *     accepted and then fails in the worker — the shape of failure docs/12 §1 prohibits.
 */
export const ORIGINAL_MIME_TYPES = ['image/jpeg', 'image/png'] as const
export type OriginalMimeType = (typeof ORIGINAL_MIME_TYPES)[number]

const KIB = 1024
const MIB = 1024 * 1024

/**
 * The placeholder a slot paints before its photograph arrives.
 *
 * A palette token **name**, not a colour. Three things follow from that and all three matter: no literal
 * colour appears outside the token layer (`pnpm colours` would reject one), the value is the same one the
 * surrounding surface uses so the swap is not a step change, and the dark theme redefines the same custom
 * property — so a placeholder does not have to be chosen twice and cannot be light in a dark document.
 *
 * Only two palette colours sit inside docs/08 §6's OKLCH placeholder band at all (`surface-sand` at
 * L=0.938 C=0.020 and `surface-clay` at L=0.888 C=0.031); eighteen of the twenty-one token names are
 * outside it. That is not a coincidence to rely on silently —
 * `packages/ui/src/tokens/slot-placeholders.test.ts` measures every token and asserts it, with the
 * eighteen as the control.
 */
export interface SlotPlaceholder {
  /** A palette token from `@berelax/ui`, without the `--color-` prefix. */
  readonly token: string
  /**
   * Why this is provisional.
   *
   * A flat colour is a placeholder for a *photograph that has not been chosen*, not a design. Y12-photos
   * is the audit that picks the real frames per slot, and until it returns, every slot's placeholder is an
   * assumption the build made — so each one is flagged, with the question id, rather than looking finished.
   */
  readonly provisional: { readonly openQuestionId: string; readonly note: string }
}

export interface MediaSlot {
  readonly name: MediaSlotName
  /** Shown in the admin beside the slot selector. An editor reads this, not the name. */
  readonly label: string
  /** Declared ratio as [w, h]; null for a slot that is never cropped. */
  readonly ratio: readonly [number, number] | null
  /** The narrowest an original may be. Below it the widest declared rung would be an upscale. */
  readonly minWidth: number
  /**
   * The shortest an original may be.
   *
   * Derived from `minWidth` and `ratio`, and stated anyway: a reader checking a rejection message should
   * not have to do the arithmetic, and `registry.test.ts` asserts the two agree so the statement cannot
   * drift from the derivation.
   */
  readonly minHeight: number
  /** The largest an original may be. An upload over this is refused, never resized. */
  readonly maxBytes: number
  readonly mimeTypes: readonly OriginalMimeType[]
  /**
   * Always true. Alt text is not optional on any slot in this system.
   *
   * Typed as the literal `true` rather than `boolean` so a slot declaring `altRequired: false` does not
   * compile — the acceptance for this unit is that every slot requires it, and an assertion a future
   * descriptor can opt out of is documentation. A genuinely decorative image is handled by
   * `decorativePermitted` below, which is an explicit editorial act on one image rather than a slot-wide
   * waiver.
   */
  readonly altRequired: true
  /**
   * Whether an image in this slot may be declared decorative and therefore carry empty alt.
   *
   * WCAG 1.1.1 is explicit that a decorative image takes `alt=""`, and a filter that demanded fifteen
   * characters everywhere would force somebody to describe a texture behind a pull-quote — which is worse
   * than silence, because a screen reader then reads it out. So empty alt is legal, but only where the
   * slot says the image can be decoration at all: a photograph of a member of staff is never decoration,
   * and `decorative` on a therapist portrait is a mistake rather than a choice.
   */
  readonly decorativePermitted: boolean
  /** Whether the two art-directed derivative ladders apply. False only for the wordmark. */
  readonly cropped: boolean
  /** Null exactly when `ratio` is null: a flat card behind a transparent wordmark is a box nobody drew. */
  readonly placeholder: SlotPlaceholder | null
  /**
   * The weight the slot's served image may reach on a published page, per crop.
   *
   * Only the hero has a number in docs/08 §8 — AVIF, widest rung, ≤95KB mobile and ≤170KB desktop — and
   * nothing else in this project does. Null therefore means "docs/08 states no budget for this slot", not
   * "unlimited": the page-level ≤1.9MB / ≤3.2MB ceiling is a property of a rendered page rather than of
   * one slot, and enforcing it is the publish-time synthetic weight check (W-SITE-10). Inventing a
   * per-slot number here would put a figure nobody derived into a refusal message.
   */
  readonly publishedBudgetBytes: { readonly mobile: number; readonly desktop: number } | null
  /** Why this slot has these constraints. */
  readonly why: string
}

/**
 * The maximum-byte figures, and where they come from.
 *
 * These are caps on the **original**, not output budgets — docs/08 §8's budgets are about what a browser
 * downloads, and the derivative job enforces those. This cap exists for two other reasons: an object in
 * the private bucket that nobody meant to keep, and AVIF encode cost in the worker, which docs/08 §8
 * budgets at 2–8 seconds per large rung and which scales with source pixels.
 *
 * The scale is set by what a correct upload actually weighs. The widest declared rung is 2560×1440 — 3.7
 * megapixels — and a JPEG of that at quality 95 is around 2MB; the largest file in the committed library
 * is 232,939 bytes. So 8MiB on the hero is roughly four times a generous correct delivery and thirty-five
 * times the largest real asset: it refuses the phone-camera dump and the accidental print-resolution
 * export without ever refusing a photographer's file. The acceptance's 12MB portrait hero is over it by
 * half again, and is refused rather than resized — resizing it would publish a crop nobody approved at a
 * quality nobody chose, and would do it silently.
 */
const MAX_BYTES = {
  hero: 8 * MIB,
  gallery: 6 * MIB,
  portrait: 4 * MIB,
  card: 4 * MIB,
  background: 4 * MIB,
  logo: 512 * KIB,
} as const

const Y12_PHOTOS = 'Y12-photos'

function provisionalPlaceholder(token: string, what: string): SlotPlaceholder {
  return {
    token,
    provisional: {
      openQuestionId: Y12_PHOTOS,
      note:
        `${what} No photograph has been chosen for this slot, so the flat ${token} surface stands in ` +
        'at the declared ratio.',
    },
  }
}

export const SLOT_REGISTRY: Readonly<Record<MediaSlotName, MediaSlot>> = {
  hero: {
    name: 'hero',
    label: 'Hero',
    ratio: [16, 9],
    minWidth: 1280,
    minHeight: 720,
    maxBytes: MAX_BYTES.hero,
    mimeTypes: ORIGINAL_MIME_TYPES,
    altRequired: true,
    // The hero `<img>` is the LCP element (docs/08 §6) and the first thing on the page. It is never
    // decoration: an empty alt here leaves the largest, most prominent image on the site unannounced.
    decorativePermitted: false,
    cropped: true,
    placeholder: provisionalPlaceholder('surface-clay', 'The hero fills the viewport.'),
    // docs/08 §8: hero poster, AVIF, widest rung.
    publishedBudgetBytes: { mobile: 95 * KIB, desktop: 170 * KIB },
    why:
      '16:9 at 1280 minimum because the desktop ladder tops out at 2560 wide and the mobile 4:5 crop is ' +
      'taken out of the same frame; anything narrower upscales on a laptop.',
  },
  'therapist-portrait': {
    name: 'therapist-portrait',
    label: 'Therapist portrait',
    ratio: [4, 5],
    minWidth: 600,
    minHeight: 750,
    maxBytes: MAX_BYTES.portrait,
    mimeTypes: ORIGINAL_MIME_TYPES,
    altRequired: true,
    // A photograph of a member of staff. Nineteen are in the library and not one has photography
    // consent recorded yet (Y12-consent-photo) — the opposite of an image with nothing to say about it.
    decorativePermitted: false,
    cropped: true,
    placeholder: provisionalPlaceholder('surface-clay', 'A portrait card reserves a 4:5 box.'),
    publishedBudgetBytes: null,
    why:
      '4:5 at 600 minimum. The nineteen real portraits are full-length at native ratios from 0.461 to ' +
      '0.799 and the face is in roughly the top fifth, so every one is cropped around a declared focal ' +
      'point rather than centred — see assets/media/README.md.',
  },
  'service-card': {
    name: 'service-card',
    label: 'Treatment card',
    ratio: [4, 5],
    minWidth: 600,
    minHeight: 750,
    maxBytes: MAX_BYTES.card,
    mimeTypes: ORIGINAL_MIME_TYPES,
    altRequired: true,
    decorativePermitted: false,
    cropped: true,
    placeholder: provisionalPlaceholder('surface-sand', 'A treatment card reserves a 4:5 box.'),
    publishedBudgetBytes: null,
    why:
      'The same 4:5 as the portrait, so a mixed grid of therapists and treatments has one row height and ' +
      'one ladder serves both.',
  },
  gallery: {
    name: 'gallery',
    label: 'Gallery',
    ratio: [16, 9],
    minWidth: 1280,
    minHeight: 720,
    maxBytes: MAX_BYTES.gallery,
    mimeTypes: ORIGINAL_MIME_TYPES,
    altRequired: true,
    // A gallery is images as content: a frame that needs no description does not need to be in it.
    decorativePermitted: false,
    cropped: true,
    placeholder: provisionalPlaceholder('surface-sand', 'A gallery tile reserves a 16:9 box.'),
    publishedBudgetBytes: null,
    why:
      '16:9 for the room and detail photography. A smaller cap than the hero because docs/08 §8 cuts the ' +
      'gallery from twelve images to six before it touches poster quality — twelve of these are on a page ' +
      'at once and the hero is one.',
  },
  'testimonial-background': {
    name: 'testimonial-background',
    label: 'Testimonial background',
    ratio: [16, 9],
    minWidth: 1280,
    minHeight: 720,
    maxBytes: MAX_BYTES.background,
    mimeTypes: ORIGINAL_MIME_TYPES,
    altRequired: true,
    // The one slot where an image can legitimately say nothing. The guest's words are the content and
    // they are already in the document; a texture behind them announced as "linen and stone" interrupts
    // the quote to describe the wallpaper. WCAG 1.1.1's decorative case, and the reason the filter
    // distinguishes empty-by-decision from empty-by-omission instead of demanding text everywhere.
    decorativePermitted: true,
    cropped: true,
    placeholder: provisionalPlaceholder('surface-clay', 'A quote sits over this image.'),
    publishedBudgetBytes: null,
    why:
      'A scrimmed 16:9 frame behind a pull-quote. The only slot that may be declared decorative, because ' +
      'it is the only one whose content is the text in front of it.',
  },
  logo: {
    name: 'logo',
    label: 'Wordmark',
    ratio: null,
    // 240px is the widest the condensed header ever draws it; a wordmark is served as authored.
    minWidth: 240,
    minHeight: 60,
    maxBytes: MAX_BYTES.logo,
    mimeTypes: ORIGINAL_MIME_TYPES,
    altRequired: true,
    decorativePermitted: false,
    cropped: false,
    placeholder: null,
    publishedBudgetBytes: null,
    why:
      'No ratio and never cropped: cropping a wordmark to 4:5 cuts the brand name in half. docs/08 §9 ' +
      'prefers an SVG here and this slot does not accept one — see the mime-type note above and the NOTE ' +
      'on W-SYS-09 in build/manifest.yaml.',
  },
}

/** Every slot descriptor, in declaration order. */
export const MEDIA_SLOT_LIST: readonly MediaSlot[] = MEDIA_SLOT_NAMES.map(
  (name) => SLOT_REGISTRY[name],
)

/** The slots the derivative ladders apply to. Derived, so it cannot disagree with `cropped`. */
export const CROPPED_SLOT_NAMES: readonly MediaSlotName[] = MEDIA_SLOT_NAMES.filter(
  (name) => SLOT_REGISTRY[name].cropped,
)

export function isMediaSlotName(name: string): name is MediaSlotName {
  return (MEDIA_SLOT_NAMES as readonly string[]).includes(name)
}

/** The descriptor for a slot name, or a named refusal. The only way to reach a slot's constraints. */
export function mediaSlot(name: string): MediaSlot {
  if (!isMediaSlotName(name)) {
    throw new AppError('validation', `[unknown-slot] '${name}' is not a declared media slot`, {
      details: { slot: name, slots: MEDIA_SLOT_NAMES },
    })
  }
  return SLOT_REGISTRY[name]
}

/** The slot's declared ratio as a single number, or null when it is never cropped. */
export function slotRatio(name: MediaSlotName): number | null {
  const ratio = SLOT_REGISTRY[name].ratio
  return ratio === null ? null : ratio[0] / ratio[1]
}

/**
 * The slot's ratio as a CSS `aspect-ratio` value, e.g. `16 / 9`.
 *
 * This function is why `[aspect-ratio-must-come-from-the-slot-registry]` can be a rule at all: a
 * component interpolates it instead of writing the number, so there is exactly one place the number
 * lives and changing it moves the crop, the card and the placeholder together.
 */
export function slotAspectRatio(name: MediaSlotName): string {
  const ratio = SLOT_REGISTRY[name].ratio
  if (ratio === null) {
    throw new AppError(
      'invariant_violated',
      `[slot-declares-no-ratio] slot '${name}' is never cropped, so it has no ratio to reserve`,
      { details: { slot: name } },
    )
  }
  return `${ratio[0]} / ${ratio[1]}`
}

/** The CSS colour for a slot's placeholder: the palette custom property, never a literal. */
export function slotPlaceholderColour(name: MediaSlotName): string {
  const placeholder = SLOT_REGISTRY[name].placeholder
  if (placeholder === null) {
    throw new AppError(
      'invariant_violated',
      `[slot-declares-no-placeholder] slot '${name}' reserves no box, so there is nothing to paint`,
      { details: { slot: name } },
    )
  }
  return `var(--color-${placeholder.token})`
}

export interface ProvisionalPlaceholder {
  readonly key: string
  readonly slot: MediaSlotName
  readonly token: string
  readonly openQuestionId: string
  readonly note: string
}

/**
 * Every slot placeholder, in the shape the Unconfirmed Assumptions panel reads.
 *
 * Deliberately the same three fields as `provisionalSettings()` in `@berelax/config` — key, question id,
 * note — so the panel concatenates rather than special-cases. These are not `app_setting` rows: a
 * placeholder is not a value anybody sets, it is one the build supplied because Y12-photos has not
 * answered. Flagging them is what stops five flat rectangles reading as a finished design.
 */
export function provisionalSlotPlaceholders(): readonly ProvisionalPlaceholder[] {
  const out: ProvisionalPlaceholder[] = []
  for (const slot of MEDIA_SLOT_LIST) {
    const placeholder = slot.placeholder
    if (placeholder === null) continue
    out.push({
      key: `media.slot.${slot.name}.placeholder`,
      slot: slot.name,
      token: placeholder.token,
      openQuestionId: placeholder.provisional.openQuestionId,
      note: placeholder.provisional.note,
    })
  }
  return out
}
