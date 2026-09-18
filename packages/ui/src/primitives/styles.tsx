/**
 * The primitive set's stylesheet, and the one element that puts it on a page.
 *
 * Assembled on the **server** side of the `'use client'` boundary on purpose. Every export of a
 * `'use client'` module is a client reference in the App Router, including a plain string — so if
 * `dialog.tsx` exported its own CSS, this file would concatenate four proxies and hand them to
 * `dangerouslySetInnerHTML`. The client primitives therefore keep their CSS in `overlay.tsx`, which has
 * no `'use client'` and whose name is what lets `pnpm layout` allow the one shadow in it.
 *
 * Separate from `DesignSystemStyles` in `@berelax/ui/layout` rather than folded into it: the layout
 * primitives are on every page, and a marketing page that renders no dialog should not carry the
 * dialog's rules. React hoists both and deduplicates by `href`, so a page that renders both ships one
 * copy of each.
 */
import { ICON_CSS } from '../icon.tsx'
import { BUTTON_CSS } from './button.tsx'
import { FIELD_PRIMITIVE_CSS } from './field.tsx'
import { OVERLAY_CSS } from './overlay.tsx'
import { SURFACE_CSS } from './surface.tsx'

/** In cascade order: the glyph, then the controls, then the surfaces that float over them. */
export const PRIMITIVES_CSS = [ICON_CSS, BUTTON_CSS, FIELD_PRIMITIVE_CSS, SURFACE_CSS, OVERLAY_CSS]
  .join('\n')
  .trim()

export function PrimitiveStyles() {
  return (
    <style
      href="berelax-primitives"
      precedence="default"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: a constant assembled from this package's own modules, never user input
      dangerouslySetInnerHTML={{ __html: PRIMITIVES_CSS }}
    />
  )
}
