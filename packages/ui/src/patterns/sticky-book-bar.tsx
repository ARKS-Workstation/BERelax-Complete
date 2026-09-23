/**
 * The sticky book bar: one action, in the thumb zone, above the home indicator.
 *
 * docs/09 §3 states the mechanics this exists to satisfy, and every one of them is a number rather than a
 * preference: *"primary actions in the lower third (thumb zone) · 48px targets with 8px gaps ·
 * `env(safe-area-inset-*)` for notch and home indicator · `100dvh` never `100vh`"*.
 *
 * ## Why `position: fixed` and not a sticky footer
 *
 * `position: sticky` keeps an element in flow and pins it only while its containing block is on screen, so
 * a bar declared sticky at the end of a long page appears at the bottom of the *document* rather than of the
 * viewport until the reader has scrolled to it — which is the one moment they no longer need it. Fixed is
 * what "always in the thumb zone" means.
 *
 * ## The two insets, which are not the same thing
 *
 * `inset-block-end: 0` puts the bar at the bottom edge of the viewport, and on a phone with a home
 * indicator that edge is underneath the indicator: the last ~34 CSS px of the screen belong to the system.
 * `padding-block-end: env(safe-area-inset-bottom)` grows the bar downwards into that strip so its
 * **background** reaches the edge while its **target** stays above the indicator. Setting
 * `inset-block-end: env(safe-area-inset-bottom)` instead — the obvious alternative — leaves a strip of page
 * scrolling underneath the bar, which looks like a rendering bug and is the version most sites ship.
 *
 * `env()` resolves to `0px` where there is no inset, so nothing here needs a fallback branch: the fallback
 * is the specification's own default.
 *
 * ## No viewport units at all
 *
 * Not one `vh`, `dvh` or `svh` appears below, and that is deliberate rather than incidental. A fixed element
 * positioned against the viewport needs no height unit — `inset-block-end` already refers to the visual
 * viewport — and `100vh` on a phone is 100 *large* viewport heights, so a bar sized with it is pushed under
 * the browser's own toolbar exactly while the toolbar is visible. `pnpm layout`'s
 * `[viewport-height-must-be-dynamic]` refuses `100vh` anywhere in `packages/ui` or `apps/web` for that
 * reason, and this component is the one that would have reached for it.
 *
 * ## Why the page has to make room for it
 *
 * A fixed bar covers whatever is at the bottom of the document, and on a phone that is the footer and the
 * last section's final line. `BOOK_BAR_SPACER_CLASS` is what a page puts at the end of its content to
 * reserve the height; the bar cannot do it for the page, because it is out of flow by definition.
 *
 * `pnpm layout` fails if this file contains `@media (min-width` — it is a container-query component like
 * every other file in this directory, and its container is itself.
 */
import type { ReactNode } from 'react'

/** The container width at which the bar stops stacking its label under its action. */
export const BOOK_BAR_LAYOUTS = [
  { minInlineSize: 0, layout: 'compact' },
  { minInlineSize: 480, layout: 'inline' },
] as const

export type BookBarLayout = (typeof BOOK_BAR_LAYOUTS)[number]['layout']

/** The class a page puts on an empty element at the end of its content, so the bar covers nothing. */
export const BOOK_BAR_SPACER_CLASS = 'be-book-bar-spacer'

/**
 * The bar's own height, as a custom property, so the spacer and the bar cannot disagree.
 *
 * 48px of target plus the block padding either side, plus whatever the device's bottom inset is. Written as
 * one expression rather than a number, because a spacer that reserved a guessed height is a spacer that is
 * wrong on every phone with a home indicator.
 */
export const BOOK_BAR_CSS = `
.be-book-bar {
  container-type: inline-size;
  container-name: book-bar;
  position: fixed;
  inset-inline: 0;
  inset-block-end: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-6);
  padding-inline: var(--gutter);
  padding-block: var(--space-5);
  /* The system's strip at the bottom of the screen. See the header: the background reaches the edge, the
     target does not. */
  padding-block-end: calc(var(--space-5) + env(safe-area-inset-bottom));
  background: var(--color-surface);
  border-block-start: 1px solid var(--color-hairline);
  /* The ring offset a section would have given it. A fixed bar has no section above it in the cascade, and
     without this the focus ring draws two pixels of the page ground on top of the bar's own surface. */
  --ring-offset: var(--color-surface);
  --book-bar-layout: compact;
}

/* What the spacer has to reserve: the two paddings, the 48px floor .be-action states, the hairline and the
   device inset. One expression, read by both — a spacer that reserved a guessed height is a spacer that is
   wrong on every phone with a home indicator.

   No backtick appears in any comment in this stylesheet. The whole thing is one template literal, so one
   backtick ends it early and everything after it is parsed as JavaScript. */
.be-book-bar-spacer {
  display: block;
  block-size: calc(var(--space-5) * 2 + 48px + 1px + env(safe-area-inset-bottom));
}

.be-book-bar__label {
  color: var(--color-ink-2);
  font-size: var(--text-sm);
  margin: 0;
  /* Below 480px the label is the button's own text and repeating it is noise in the one place there is no
     room for any. */
  display: none;
}

.be-book-bar__action { flex: 0 1 auto; }

@container book-bar (min-width: 480px) {
  .be-book-bar {
    --book-bar-layout: inline;
    justify-content: space-between;
  }
  .be-book-bar__label { display: block; }
}
`

export interface StickyBookBarProps {
  /** The accessible name of the region. A landmark with no name is one a screen reader cannot skip to. */
  readonly ariaLabel: string
  /** Shown beside the action from 480px up. The action's own label carries the meaning below that. */
  readonly label?: ReactNode
  readonly action: {
    readonly href: string
    readonly text: string
    /** The action's accessible name, when the visible text is shorter than what it does. */
    readonly ariaLabel?: string
  }
}

/**
 * The bar.
 *
 * `.be-action` rather than a size of its own: that class is the one place the 48px touch floor is written
 * down (`packages/ui/src/layout/styles.tsx` records why — *"a floor that each component arrives at through
 * its own padding arithmetic is a floor that half of them miss"*), and it is also what puts this control in
 * the one focus-ring rule the system has.
 */
export function StickyBookBar({ ariaLabel, label, action }: StickyBookBarProps) {
  return (
    // A <section> rather than a <div role="region">: the element already has the role, and Biome's
    // useSemanticElements is right that spelling it out is the version that drifts.
    <section className="be-book-bar" aria-label={ariaLabel} data-book-bar="">
      {label === undefined ? null : <p className="be-book-bar__label">{label}</p>}
      <a
        className="be-action be-book-bar__action"
        href={action.href}
        aria-label={action.ariaLabel ?? action.text}
      >
        {action.text}
      </a>
    </section>
  )
}

/** The element a page ends with, so the bar covers nothing. Empty and inert; see the header. */
export function BookBarSpacer() {
  return <div className={BOOK_BAR_SPACER_CLASS} aria-hidden="true" />
}
