/**
 * The editorial grid: one asymmetry, repeated everywhere.
 *
 * docs/08 §4 specifies a single five-track template and asks that every page use it rather than
 * inventing a layout per section. The tracks are, from the outside in: a gutter that may grow, a
 * 12rem wide column, the measure, a 20rem wide column, a gutter that may grow. The asymmetry — 12rem
 * on one side, 20rem on the other — is what makes a page look composed rather than centred, and
 * repeating one asymmetry is what makes eleven pages look like one site.
 *
 * ## Why the template is a string constant
 *
 * `EDITORIAL_GRID_TEMPLATE` is interpolated into the stylesheet rather than typed into it, because
 * `apps/web/src/kitchen-sink.itest.ts` reads the template out of **docs/08 §4 itself**, out of the
 * authored stylesheet, and out of the browser's computed track sizes, and fails when the three
 * disagree. A second copy of these numbers is the copy that goes stale.
 *
 * ## Why the CSS lives in this file
 *
 * A component's rules ship with the component. It keeps the `@media`/`@container` decisions where the
 * markup they govern is — which is what makes `pnpm layout`'s "a pattern component contains no
 * `@media (min-width`" rule a check of something rather than a check of an empty file — and it is the
 * idiom `packages/harness/src/specimen.ts` already uses, so the colour gate already reads CSS out of
 * template literals here.
 *
 * `--gutter` and `--container-max` come from `packages/ui/src/tokens/scale.ts`; nothing here restates
 * a number the token layer owns.
 */
import type { ElementType, ReactNode } from 'react'

/**
 * The docs/08 §4 template, verbatim.
 *
 * `min(68ch, 100% - var(--gutter) * 2)` is the load-bearing part: the measure is capped at 68
 * characters *and* at the container minus its gutters, so one track works at 360px, where 68ch does
 * not fit, and at 1440px, where it does and must not grow past it.
 */
export const EDITORIAL_GRID_TEMPLATE =
  '[full-start] minmax(var(--gutter), 1fr) ' +
  '[wide-start] minmax(0, 12rem) ' +
  '[measure-start] min(68ch, 100% - var(--gutter) * 2) [measure-end] ' +
  'minmax(0, 20rem) [wide-end] ' +
  'minmax(var(--gutter), 1fr) [full-end]'

/** Where a child sits. A named line pair `x-start`/`x-end` is an implicit named area, hence `wide`. */
export type GridSpan = 'measure' | 'wide' | 'full'

export const GRID_CSS = `
.be-grid {
  display: grid;
  grid-template-columns: ${EDITORIAL_GRID_TEMPLATE};
  /* A column gap would sit inside the gutter tracks and make the measure narrower than it says. */
  column-gap: 0;
  row-gap: var(--space-8);
  /* docs/08 §4: container 1360px. The gutter tracks are inside it, so an edge-to-edge band is a
     section's background rather than the grid's — see section.tsx. */
  max-inline-size: var(--container-max);
  margin-inline: auto;
  align-content: start;
}

/* Content sits in the measure by default: the point of one grid is that a section which states
   nothing is still laid out. */
.be-grid > * { grid-column: measure; min-inline-size: 0; }
.be-grid > [data-span='wide'] { grid-column: wide; }
.be-grid > [data-span='full'] { grid-column: full; }
`

export interface GridProps {
  readonly children: ReactNode
  /** The rendered element. A grid of list items has to be a list. */
  readonly as?: 'div' | 'section' | 'ul' | 'ol' | 'header' | 'footer'
  readonly className?: string
}

/** The editorial grid. Children land in the measure unless they say otherwise. */
export function Grid({ children, as = 'div', className }: GridProps) {
  const Element = as as ElementType
  return (
    <Element className={className === undefined ? 'be-grid' : `be-grid ${className}`}>
      {children}
    </Element>
  )
}

export interface GridCellProps {
  readonly children: ReactNode
  readonly span?: GridSpan
  readonly as?: 'div' | 'section' | 'article' | 'ul' | 'li' | 'header' | 'footer'
  readonly className?: string
}

/**
 * A child of the grid, placed by name.
 *
 * The measure is the absence of an attribute rather than `data-span="measure"`, so the default in the
 * stylesheet and the default in the type are one fact stated once.
 */
export function GridCell({ children, span = 'measure', as = 'div', className }: GridCellProps) {
  const Element = as as ElementType
  return (
    <Element className={className} data-span={span === 'measure' ? undefined : span}>
      {children}
    </Element>
  )
}
