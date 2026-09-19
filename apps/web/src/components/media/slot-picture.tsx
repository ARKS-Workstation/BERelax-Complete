import { CROPS } from '@berelax/media/ladders'
import { mediaSlot, slotPlaceholderColour } from '@berelax/media/slots'
import {
  DEFAULT_SIZES,
  type DerivativeSetRef,
  fallbackDimensions,
  fallbackSrcFor,
  pictureSourcesFor,
} from '@berelax/media/srcset'
import type { ReactElement } from 'react'

/**
 * The production image: an art-directed `<picture>` over one media row.
 *
 * This is the component every page renders a slot image with, and it is the component the admin's
 * breakpoint preview is asserted against. Both take their `srcset` from `pictureSourcesFor` in
 * `@berelax/media/srcset`, which is the whole point — a preview built on a second builder shows an editor a
 * ladder the site does not serve, and neither side fails.
 *
 * ## Why a server component with no `'use client'`
 *
 * There is nothing interactive here. ADR 0013 renders the public site on the server so the HTML arrives
 * complete — a `<picture>` assembled in the browser is invisible to every crawler that does not run
 * JavaScript, which is the channel docs/07 §3 is optimising for.
 *
 * ## Why the reserved box takes TWO ratios and not `slotAspectRatio()`
 *
 * Without a reserved box the image has no intrinsic size until the first bytes land and everything below it
 * moves — a CLS regression that shows up in field data weeks later and is attributed to anything but the
 * photograph. `scripts/check-media.mjs` therefore refuses a literal ratio and points at
 * `slotAspectRatio(slot)`, and for this element that helper is **not enough**: it answers the slot's ratio,
 * one number, while an art-directed slot is served at the ladder's *two* — 4:5 below 768px and 16:9 above
 * it. A single `aspect-ratio` here would reserve a 16:9 box on a phone and then hand it the 4:5 crop, which
 * is the reflow the box exists to prevent, arriving only on phones.
 *
 * So the box is reserved per crop, by a stylesheet whose media query and ratios both come from `CROPS`. It
 * carries `href` and `precedence` so React 19 hoists it into the head and emits it once however many images
 * a page renders. Nothing here states a number.
 *
 * The placeholder is the slot's palette token (`slotPlaceholderColour`), so the box is the surrounding
 * surface's colour rather than white or grey — the swap when the photograph lands is not a step change. It
 * is provisional until Y12-photos chooses the photography; `provisionalSlotPlaceholders()` is what says so
 * on the Unconfirmed Assumptions panel.
 *
 * **Unexercised until a route renders an image.** No indexable route does yet — `apps/web` serves two
 * placeholder pages and neither carries a photograph — so this component's markup is asserted by
 * `apps/web/src/breakpoint-preview.itest.ts` (which renders it and compares its `srcset`) and not by a page.
 * W-SITE-04 and W-SITE-06 are the first routes that will render one.
 */
export interface SlotPictureProps {
  readonly media: DerivativeSetRef
  /**
   * What the image shows, or `null` for an image the row declares decorative.
   *
   * `null` and not an optional prop: alt text is required on every slot (`altRequired: true` is the literal
   * `true` in the registry), and an omitted prop is how an image ships unannounced. Saying `null` is a
   * decision, which is the difference WCAG 1.1.1 turns on.
   */
  readonly alt: string | null
  /** The layout's rendered width, for the browser to choose a rung with. Full-bleed by default. */
  readonly sizes?: string
  /** True for the LCP element — one per page (docs/08 §8). */
  readonly priority?: boolean
}

export function SlotPicture({
  media,
  alt,
  sizes = DEFAULT_SIZES,
  priority = false,
}: SlotPictureProps): ReactElement {
  const slot = mediaSlot(media.slot)
  const sources = pictureSourcesFor(media, sizes)
  const box = fallbackDimensions()
  return (
    <>
      {/*
       * The reserved box, per crop. The ratios and the media query are read out of `CROPS`, so this stays
       * correct if a ladder is ever re-cut — and `pnpm media` allows `var()` precisely so that a ratio can
       * arrive from the registry rather than be typed.
       */}
      <style href="berelax-slot-picture" precedence="default">
        {`.slot-picture{display:block;aspect-ratio:var(--slot-picture-ratio)}` +
          `.slot-picture{--slot-picture-ratio:${CROPS.mobile.ratio.join(' / ')}}` +
          `@media ${CROPS.desktop.media}{` +
          `.slot-picture{--slot-picture-ratio:${CROPS.desktop.ratio.join(' / ')}}}`}
      </style>
      <picture
        className="slot-picture"
        data-slot={slot.name}
        style={{ background: slotPlaceholderColour(slot.name) }}
      >
        {sources.map((source) => (
          <source
            key={`${source.crop}-${source.format}`}
            type={source.type}
            media={source.media}
            srcSet={source.srcset}
            sizes={source.sizes}
          />
        ))}
        {/*
         * `alt=""` for a decorative image, and never a missing attribute: a screen reader announces the
         * filename of an `<img>` with no alt, which is worse than silence.
         *
         * `fetchPriority="high"` and `decoding="sync"` only on the LCP element. Everywhere else the defaults
         * are right, and marking every image high priority is the same as marking none.
         */}
        <img
          src={fallbackSrcFor(media)}
          alt={alt ?? ''}
          width={box.width}
          height={box.height}
          {...(priority
            ? {
                fetchPriority: 'high' as const,
                decoding: 'sync' as const,
                loading: 'eager' as const,
              }
            : { decoding: 'async' as const, loading: 'lazy' as const })}
          style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </picture>
    </>
  )
}
