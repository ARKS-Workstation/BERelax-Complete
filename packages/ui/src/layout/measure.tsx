/**
 * The measure: a width in characters, resolved in the element's own font.
 *
 * ## Why `ch` on the element rather than a pixel width on a wrapper
 *
 * A measure is a count of characters, not a distance. `68ch` set on the paragraph resolves against
 * *that paragraph's* font, so the same token gives the right line on the 17px body sans, on the 20px
 * lede, and on the Arabic face at its 1.06 scalar — all of which have different advance widths. A
 * pixel wrapper gets one of those three right and quietly ruins the other two, and the symptom is a
 * line that runs to 90 characters on one route and nobody can see why.
 *
 * ## Why there is no hard cap in the CSS
 *
 * It is tempting to write `min(var(--measure), 76ch)` so nothing can ever exceed the docs/08 §3
 * maximum. That would make the assertion in `kitchen-sink.itest.ts` that no measured element exceeds
 * 76ch true by construction — a test that cannot fail. The caps come from `MEASURE` in
 * `tokens/scale.ts`, the test measures every element against them *and* against the 76ch ceiling, and
 * a role whose token drifts is meant to fail there rather than be silently clamped here.
 */
import type { ElementType, ReactNode } from 'react'
import { MEASURE } from '../tokens/scale.ts'

/** The roles with a stated measure. `max` is the ceiling for all of them, not a role. */
export type MeasureRole = Exclude<keyof typeof MEASURE, 'max'>

const ROLES = Object.keys(MEASURE).filter((role): role is MeasureRole => role !== 'max')

export const MEASURE_CSS = `
.be-measure { max-inline-size: var(--measure); }
${ROLES.map(
  (role) => `.be-measure[data-measure='${role}'] { --measure: ${MEASURE[role]}ch; }`,
).join('\n')}
`

export interface MeasureProps {
  readonly children: ReactNode
  /**
   * Which cap to apply.
   *
   * Named `cap` rather than `role`, which is what it is: Biome's `useValidAriaRole` reads a `role`
   * attribute on a component as the ARIA one and rejects `role="body"` — correctly, since anybody
   * reading the JSX would make the same mistake.
   */
  readonly cap: MeasureRole
  readonly as?: 'p' | 'div' | 'h1' | 'h2' | 'h3' | 'ul' | 'dl' | 'blockquote'
  readonly className?: string
}

/**
 * Caps the line length of long-form text.
 *
 * Width only. Size, leading and colour belong to the text role and come from the type scale — mixing
 * them in here would mean a heading could not borrow the body measure without also borrowing 17px.
 */
export function Measure({ children, cap, as = 'p', className }: MeasureProps) {
  const Element = as as ElementType
  return (
    <Element
      className={className === undefined ? 'be-measure' : `be-measure ${className}`}
      data-measure={cap}
    >
      {children}
    </Element>
  )
}
