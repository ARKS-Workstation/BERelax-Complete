import { CROP_NAMES, CROPS, type CropName } from '@berelax/media/ladders'
import { DEFAULT_SIZES, type DerivativeSetRef, srcsetFor } from '@berelax/media/srcset'
import { heroVideoSources } from '@berelax/media/video'
import { HERO_MEDIA_CSS, HERO_SOURCES_ATTRIBUTE, HERO_STATE_ATTRIBUTE } from '@berelax/ui/media'
import HeroVideoIsland from '@berelax/ui/media/attach-video-island'
import { HeroPauseControl, type HeroPauseControlCopy } from '@berelax/ui/media/pause-control'
import type { ReactElement } from 'react'
import { preload } from 'react-dom'
import { SlotPicture } from './slot-picture.tsx'

/**
 * The hero: a real `<img>` that is the LCP element, and a `<video>` that costs nothing until it is free.
 *
 * docs/08 §6 calls this "the technique that makes a video hero free", and the cost of the obvious version
 * is stated there: a video as the LCP candidate is +0.3–0.9s LCP on mid-tier 4G, which no amount of
 * caching fixes. Every part of this component exists to keep the video out of that measurement.
 *
 * ## The four facts this markup has to be true about
 *
 * 1. **The `<img>` is real, eager, and the largest thing on the page.** It comes from `SlotPicture` — the
 *    production `<picture>`, art-directed from the same `pictureSourcesFor` the admin preview renders — with
 *    `priority`, which is what puts `fetchpriority="high"` and `decoding="sync"` on it. Nothing here builds
 *    a second `srcset`: W-SYS-10 made that builder the one answer and a lookalike would be the second.
 * 2. **The `<video>` has no `src` and no `poster`.** Not "a small poster" — none. `poster` would be a
 *    second copy of the hero image, fetched by the video element, *competing with* the `<img>` for the
 *    same LCP; and a `src` would make the video itself a candidate. The element therefore has no resource
 *    at all until the island runs, which is why the largest-contentful-paint entry is already final and
 *    already the photograph.
 * 3. **The renditions travel as data.** `data-hero-sources` is JSON, and an attribute fetches nothing. It
 *    is built by `heroVideoSources()` in `@berelax/media/video` — the module the encoder's own argv comes
 *    from — so the island cannot ask for a rendition the job does not produce, and each entry carries its
 *    crop's media query because `media` on a `<source>` inside a `<video>` does nothing (see the island).
 * 4. **The preload is art-directed, two links, one per breakpoint.** docs/08 §6 spells it out. Two links
 *    and not one: a single `imagesrcset` cannot express two crops, and the browser would preload a 16:9
 *    frame for a phone that is about to render the 4:5 one — a wasted download of exactly the size of the
 *    thing being optimised.
 *
 * ## Why `preload()` and not two `<link>` elements
 *
 * Rendering the links as JSX produces **four** of them, which is how this was found. React 19 hoists a
 * `<link rel="preload">` into the head *and* registers it as a float resource, and the two emissions are
 * keyed differently — so the head ends up with the element and the directive, one pair per crop, pointing
 * at the same two ladders. Nothing is downloaded twice (the browser resolves both to one URL) and nothing
 * looks wrong; the criterion "the head contains exactly two `<link rel="preload" as="image">`" is simply
 * false. Calling `preload()` is React's own API for this and emits exactly one link per distinct key.
 *
 * The `href` passed is the crop's **narrowest rung**: it is the fallback for a browser that does not
 * implement `imagesrcset`, so it has to be a member of the set this link is preloading — a desktop link
 * whose fallback is a phone crop preloads the wrong photograph. React writes an `imagesrcset` preload
 * without an `href` attribute, which is the responsive-preload form the HTML specification allows, so the
 * value is what keys the two calls apart rather than something a browser reads.
 */
export interface HeroMediaCopy {
  /** What the photograph shows. Required: the hero is the one image on the page nobody can skip. */
  readonly alt: string
  readonly control: HeroPauseControlCopy
}

export interface HeroMediaProps {
  /** The poster's media row and content address. */
  readonly poster: DerivativeSetRef
  /**
   * The video master's row and content address.
   *
   * A separate reference from the poster's, because they are separate objects: the master is a video in the
   * private bucket, addressed by its own bytes, and the renditions are addressed by the master's hash. A
   * single ref would have to assume the two were uploaded together, and would silently serve the poster's
   * hash in a video URL the day they were not.
   */
  readonly video: { readonly mediaId: string; readonly contentHash: string }
  readonly copy: HeroMediaCopy
  /** The layout's rendered width. Full-bleed by default, which is what a hero is. */
  readonly sizes?: string
}

/** A crop's narrowest rung: the `href` a responsive preload is keyed by. */
function fallbackRung(poster: DerivativeSetRef, crop: CropName): string {
  return srcsetFor(poster, crop, 'avif').split(' ')[0] ?? ''
}

export function HeroMedia({
  poster,
  video,
  copy,
  sizes = DEFAULT_SIZES,
}: HeroMediaProps): ReactElement {
  // Only the three fields the island reads. The crop and the codec are in the declaration and are not
  // needed in the browser, and every byte of this attribute is in the HTML of a page budgeted at 250KB
  // above the fold.
  const sources = heroVideoSources({ ...video, slot: 'hero' }).map((source) => ({
    src: source.src,
    type: source.type,
    media: source.media,
  }))
  for (const crop of CROP_NAMES) {
    preload(fallbackRung(poster, crop), {
      as: 'image',
      media: CROPS[crop].media,
      // AVIF only. A preload declares a type so a browser that cannot decode it skips the link rather
      // than downloading a file it will then discard; the `<picture>` below still offers WebP and JPEG
      // to that browser through its own `<source>` list.
      type: 'image/avif',
      imageSrcSet: srcsetFor(poster, crop, 'avif'),
      imageSizes: sizes,
      fetchPriority: 'high',
    })
  }
  return (
    <>
      <style
        href="berelax-hero-media"
        precedence="default"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: a constant from @berelax/ui, never user input
        dangerouslySetInnerHTML={{ __html: HERO_MEDIA_CSS }}
      />
      <div className="be-hero" {...{ [HERO_STATE_ATTRIBUTE]: 'still' }}>
        <SlotPicture media={poster} alt={copy.alt} sizes={sizes} priority />
        {/*
          No `src`, no `poster`, no `autoplay`, and `preload="none"` — four absences, each load-bearing.
          The island raises `preload` and appends the sources it has chosen; until then this element has no
          resource, paints nothing, and is not an LCP candidate.

          `aria-hidden` with `tabIndex={-1}`: the loop is decoration over a photograph that already carries
          the alt text, so announcing it twice would be announcing it twice. The control beside it is a real
          button in the tab order, which is what WCAG 2.2.2 asks for.
        */}
        <video
          className="be-hero__video"
          preload="none"
          muted
          loop
          playsInline
          aria-hidden="true"
          tabIndex={-1}
          {...{ [HERO_SOURCES_ATTRIBUTE]: JSON.stringify(sources) }}
        />
        <HeroPauseControl copy={copy.control} />
        {/*
          The island. A static import from a server component is already code-split by Next — it is a
          client reference, so it becomes its own chunk on this route and nothing else. `next/dynamic`
          would add a loading boundary and change nothing about the bytes; `build/budgets.json` measures
          the chunk that defines this module at 2KB, which is the acceptance criterion.
        */}
        <HeroVideoIsland />
      </div>
    </>
  )
}
