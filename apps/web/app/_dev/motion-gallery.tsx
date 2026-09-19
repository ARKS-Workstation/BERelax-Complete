/**
 * The motion system, on a page, in whichever locale renders it.
 *
 * ## Why this exists rather than a screenshot
 *
 * Nothing W-SYS-04 claims can be read off source. `--dur-reveal` collapsing to 120ms under
 * `prefers-reduced-motion` is a computed custom property; movement becoming zero while an opacity
 * cross-fade survives is two samples of `getComputedStyle` a frame apart; a stagger is the difference
 * between two animations' start times; a scroll-driven effect is a progress-based timeline that has no
 * current time in milliseconds at all. So `apps/web/src/motion.itest.ts` drives this in a real browser,
 * in two contexts — one with reduced motion, one without — and every assertion has a control.
 *
 * It sits on the kitchen sink rather than on a route of its own because the reveal has to be **below the
 * fold** to be a reveal, the header has to be at the top of a page long enough to scroll, and the Arabic
 * sink already exists as a real RTL document. A new route would also have to be declared in the registry
 * in both locales, screenshotted, and swept by axe — three costs for a second dev surface.
 *
 * ## Two exports, because the header is not a section
 *
 * `MotionHeader` goes at the top of `<main>`, above everything: it is sticky, and its condensation is
 * driven by document scroll. `MotionGallery` goes near the bottom, where a reveal is genuinely below the
 * fold. The islands are dynamically imported here and nowhere else — `pnpm layout`'s
 * `motion-island-must-be-a-dynamic-client-module` fails the build on a static import of either, and
 * `no-motion-in-the-shared-layout` in `.dependency-cruiser.cjs` fails it if the shell or a layout
 * primitive reaches for one.
 */
import { staggerChildVars, staggerContainerVars, staggerFor } from '@berelax/ui'
import dynamic from 'next/dynamic'

/**
 * The two islands, code-split.
 *
 * `dynamic()` rather than a plain import, and no `ssr: false`: both render nothing that carries content
 * — one returns `null`, the other an empty sentinel — so server-rendering them costs nothing and skipping
 * it would buy nothing. What `dynamic()` buys is the chunk boundary the island budget measures: without
 * it the fallbacks would be part of whatever chunk the page's other client references landed in, and
 * "≤40KB gzip per island" would have nothing to point at.
 */
const RevealFallback = dynamic(() => import('@berelax/ui/motion/reveal'))
const HeaderCondense = dynamic(() => import('@berelax/ui/motion/header-condense'))

/**
 * The gallery's own layout. A development surface, so it is here and not in `packages/ui`.
 *
 * No animation in this stylesheet and no `animation-timeline`: every animation on this site is in
 * `@berelax/ui/motion.css`, which is what lets `pnpm layout` count the scroll-driven effects. What is
 * here is a list that does not look like a list and a number big enough to watch cross-fade.
 *
 * The display face is a utility on the element rather than a declaration in here, and so is every size.
 * `pnpm colours` reads a stylesheet in a template literal as one string, so the display family beside a
 * 14px rule anywhere in the same block is reported as the display serif at 14px — and the rule is right to
 * be suspicious, because that is exactly what the mistake looks like. (The explanation is in this comment
 * rather than in the stylesheet for the same reason: the words are enough to trip it.)
 */
const MOTION_GALLERY_CSS = `
.be-motion { display: flex; flex-direction: column; gap: var(--space-9); }

.be-motion__group {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  margin: 0;
  padding: 0;
  list-style: none;
}

.be-motion__row {
  padding: var(--space-3) var(--space-6);
  border: 1px solid var(--color-hairline);
  border-radius: var(--radius-1);
  background: var(--color-surface);
  color: var(--color-ink-2);
  font-size: var(--text-sm);
}

.be-motion__figure { margin: 0; display: flex; flex-direction: column; gap: var(--space-4); }

.be-header__meta { font-size: var(--text-sm); color: var(--color-ink-2); }
`

export interface MotionGalleryCopy {
  readonly brand: string
  readonly scrolled: string
  readonly heading: string
  readonly body: string
  readonly reveal: string
  readonly groups: {
    readonly small: string
    readonly large: string
    readonly capped: string
  }
  /** The label each row of a staggered group carries, before its number. */
  readonly row: string
  readonly crossfade: string
  /** A gross, VAT-inclusive price, already formatted for the locale. */
  readonly price: string
}

/** The sizes the three staggered groups demonstrate: the 40ms step, the 24ms step, and the cliff. */
const GROUP_SIZES = { small: 6, large: 10, capped: 14 } as const

/**
 * The condensing header. docs/08 §5: "height + blur on `animation-timeline: scroll()`".
 *
 * A `div` rather than a `<header>`: the kitchen sink already renders one inside `<main>`, and a second
 * would be a second thing for a screen reader to skip past on a page whose subject is animation. The
 * real site header (W-SITE) takes the class and keeps its own element.
 */
export function MotionHeader({ copy }: { copy: MotionGalleryCopy }) {
  return (
    <>
      <style
        href="berelax-dev-motion"
        precedence="default"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: a constant in this module, never user input
        dangerouslySetInnerHTML={{ __html: MOTION_GALLERY_CSS }}
      />
      {/* Renders the sentinel the fallback watches, one header's height above the header itself. */}
      <HeaderCondense />
      <div className="be-header">
        <span className="font-display text-lg text-ink">{copy.brand}</span>
        <span className="be-header__meta">{copy.scrolled}</span>
      </div>
    </>
  )
}

/**
 * One staggered group.
 *
 * The children carry an index and the group carries a unitless scale — never the step as a time, which
 * would shadow the `--stagger` token and take the reduced-motion override with it (`motion/stagger.ts`).
 * `[data-stagger] > *` in `@berelax/ui/motion.css` multiplies the three. Above twelve siblings both
 * helpers return nothing and the group carries `data-reveal` instead: one animation for the container,
 * which is the whole point of the cliff.
 */
function StaggeredGroup({ count, label, row }: { count: number; label: string; row: string }) {
  const children = Array.from({ length: count }, (_, index) => index)
  const { animateChildren } = staggerFor(count)
  return (
    <ul
      aria-label={label}
      className="be-motion__group"
      data-stagger
      data-stagger-count={count}
      // Above twelve siblings the container carries the single animation and the children carry none.
      data-reveal={animateChildren ? undefined : ''}
      style={staggerContainerVars(count)}
    >
      {children.map((index) => (
        <li className="be-motion__row" key={index} style={staggerChildVars(index, count)}>
          {row} <bdi dir="ltr">{index + 1}</bdi>
        </li>
      ))}
    </ul>
  )
}

export function MotionGallery({ copy }: { copy: MotionGalleryCopy }) {
  return (
    <div className="be-motion">
      {/* Loads in a browser with no scroll-driven animations, and does nothing in one that has them. */}
      <RevealFallback />

      <p>{copy.body}</p>

      <StaggeredGroup count={GROUP_SIZES.small} label={copy.groups.small} row={copy.row} />
      <StaggeredGroup count={GROUP_SIZES.large} label={copy.groups.large} row={copy.row} />
      <StaggeredGroup count={GROUP_SIZES.capped} label={copy.groups.capped} row={copy.row} />

      {/*
        The reveal, and the cross-fade the reduced-motion path is proved against.

        The figure has `data-reveal`, so it arrives as the reader reaches it. The number inside it carries
        no animation until something adds `data-crossfade` — which is what a component does when the value
        behind it has changed, and what `motion.itest.ts` does to watch an opacity change happen with
        movement zeroed.
      */}
      <figure className="be-motion__figure" data-reveal>
        <span className="font-display text-2xl text-ink" data-motion-specimen="crossfade">
          <bdi dir="ltr">{copy.price}</bdi>
        </span>
        <figcaption>{copy.crossfade}</figcaption>
      </figure>

      <p data-reveal>{copy.reveal}</p>
    </div>
  )
}
