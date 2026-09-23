/**
 * A band of the page: vertical rhythm, one surface, and the focus-ring offset that goes with it.
 *
 * ## Why a section owns `--ring-offset`
 *
 * docs/08 §4 asks each section to set `--ring-offset` to its own background. A focus ring drawn with
 * `outline-offset: 2px` shows two pixels of whatever is *behind* the control, so a ring that assumes
 * the page ground has a two-pixel halo of the wrong colour on every sand band — the one place the ring
 * is hardest to see and most needed. The token makes the background a section states rather than a
 * component guesses, and `kitchen-sink.itest.ts` asserts the two are equal on every section.
 *
 * The section is full width and carries the surface; the grid inside it is capped at
 * `--container-max`. That split is what makes an edge-to-edge sand band possible without a second
 * layout: the colour bleeds, the content does not.
 */
import type { ElementType, ReactNode } from 'react'

/** The surfaces a band may use. Every one is a measured token; none is a new colour. */
export type SectionSurface = 'ground' | 'sunk' | 'surface' | 'sand'

export const SECTION_CSS = `
.be-section {
  /* One rhythm, so two adjacent sections cannot disagree about how far apart they are. */
  padding-block: var(--space-11);
  background: var(--color-ground);
  --ring-offset: var(--color-ground);
}

.be-section[data-surface='sunk'] {
  background: var(--color-ground-sunk);
  --ring-offset: var(--color-ground-sunk);
}

.be-section[data-surface='surface'] {
  background: var(--color-surface);
  --ring-offset: var(--color-surface);
}

.be-section[data-surface='sand'] {
  background: var(--color-surface-sand);
  --ring-offset: var(--color-surface-sand);
}

/* Two bands on the same surface read as one band, so the second one drops its top padding. */
.be-section + .be-section[data-surface='ground'] { padding-block-start: 0; }

.be-section__heading { margin-block: 0 var(--space-8); }
`

export interface SectionProps {
  readonly children: ReactNode
  readonly surface?: SectionSurface
  readonly as?: 'section' | 'div' | 'header' | 'footer' | 'main'
  /** Labels the band for assistive technology when its heading is not its first child. */
  readonly ariaLabel?: string
  /** An anchor target, so a link can send the reader to this band. */
  readonly id?: string
  /**
   * `-1` makes the band focusable without putting it in the tab order.
   *
   * Added by W-SITE-04, and it is not decoration: a `<section id="about">` is an anchor target that a
   * browser will *scroll* to and will not *focus*, so a reader using a keyboard or a screen reader follows
   * an in-page link and their focus stays where it was — on the link they just left. The next Tab then goes
   * to the link after it rather than into the section they asked for. `tabindex="-1"` is what WCAG 2.4.1's
   * bypass-blocks technique relies on and it is the whole difference between a link that moves the page and
   * a link that moves the reader.
   *
   * Optional and never defaulted: a band with no id is not a target, and making every band focusable would
   * put a focus ring around a whole section for a click that landed inside it.
   */
  readonly tabIndex?: -1
  readonly className?: string
}

export function Section({
  children,
  surface = 'ground',
  as = 'section',
  ariaLabel,
  id,
  tabIndex,
  className,
}: SectionProps) {
  const Element = as as ElementType
  return (
    <Element
      className={className === undefined ? 'be-section' : `be-section ${className}`}
      data-surface={surface}
      aria-label={ariaLabel}
      id={id}
      tabIndex={tabIndex}
    >
      {children}
    </Element>
  )
}
