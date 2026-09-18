/**
 * The design system's stylesheet, and the one element that puts it on a page.
 *
 * Everything here is authored CSS in a template literal, for three reasons that have each already cost
 * somebody an afternoon:
 *
 * 1. **A rule has to be readable back.** `kitchen-sink.itest.ts` reads the grid template and the focus
 *    ring out of `document.styleSheets`, because `getComputedStyle` resolves `padding-inline` to
 *    `padding-left` and cannot tell correct logical CSS from incorrect physical CSS. An inline `style`
 *    attribute is not in `document.styleSheets` at all.
 * 2. **A component's rules ship with the component**, so `pnpm layout`'s "no `@media (min-width` in a
 *    container-query component" is a check of the file that actually contains the query.
 * 3. **One `<style>` element, once.** React hoists it and deduplicates by `href`, so a page that
 *    renders two primitives does not ship two copies.
 *
 * The reveal and the focus ring live here rather than beside a component because they are properties of
 * the system: one keyframe set, one ring, applied to whatever asks for them.
 */
import { SERVICE_ROW_CSS } from '../patterns/service-row.tsx'
import { SLOT_GRID_CSS } from '../patterns/slot-grid.tsx'
import { THERAPIST_CARD_CSS } from '../patterns/therapist-card.tsx'
import { GRID_CSS } from './grid.tsx'
import { MEASURE_CSS } from './measure.tsx'
import { SECTION_CSS } from './section.tsx'

/**
 * The focus ring: 2px, `--color-focus`, offset 2px. docs/08 §4.
 *
 * `:where()` so the ring carries no specificity of its own and a component can still restyle the
 * control it is on without having to out-specify the system.
 *
 * The two pixels of offset show whatever is behind the control, which is why every section states
 * `--ring-offset` — see `section.tsx`.
 */
export const FOCUS_CSS = `
:where(
  .be-slot,
  .be-action,
  .be-card__link,
  .be-disclosure__summary,
  .be-field__input,
  .be-field__select
):focus-visible {
  outline: 2px solid var(--color-focus);
  outline-offset: 2px;
}
`

/**
 * The action: the 48px floor, stated once.
 *
 * docs/08 §4 puts the minimum touch target at 48px on mobile and 40px on a desk, with 8px between
 * neighbours. Both numbers are here, as `min-block-size` and `min-inline-size` on one class, because a
 * floor that each component arrives at through its own padding arithmetic is a floor that half of them
 * miss — a 32px button is what `padding: 4px 10px` produces, and it looks deliberate.
 *
 * This is not the Button component: variants, loading state, icon slots and the anchor/button decision
 * belong to W-SYS-03. It is the smallest thing the primitives need in order to be demonstrable, and the
 * one place the floor is written down.
 */
export const ACTION_CSS = `
.be-actions {
  display: flex;
  flex-wrap: wrap;
  /* 20px, comfortably over the 8px minimum between targets. */
  gap: var(--space-6);
}

.be-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* An action may carry a glyph beside its label — the spine's back link does. Without a gap the two
     touch, and the value is the same one \`.be-btn\` uses, so an action and a button space a glyph
     identically rather than by eye. */
  gap: var(--space-4);
  min-block-size: 48px;
  min-inline-size: 48px;
  padding-inline: var(--space-8);
  border: 1px solid transparent;
  border-radius: var(--radius-2);
  background: var(--color-accent-gold);
  color: var(--color-ground);
  font-weight: 600;
  text-decoration: none;
  /* docs/08 §5: hover is 140ms of colour. Nothing moves, because nothing moved to get here. */
  transition: background-color var(--dur-fast) var(--ease-calm);
}

.be-action:hover { background: var(--color-accent-gold-strong); }

.be-action--quiet {
  background: transparent;
  color: var(--color-accent-teal);
  border-color: var(--color-border-strong);
}
`

/**
 * A field. docs/08 §4 gives inputs `--radius-1` and selects `--radius-2`, which is not a whim: a select
 * is a button that happens to hold a value, and it should read as one.
 */
export const FIELD_CSS = `
.be-field { display: flex; flex-direction: column; gap: var(--space-3); }

.be-field__label { font-size: var(--text-sm); color: var(--color-ink-2); }

.be-field__input,
.be-field__select {
  min-block-size: 48px;
  padding-inline: var(--space-6);
  border: 1px solid var(--color-border-strong);
  background: var(--color-surface);
  color: var(--color-ink);
  font: inherit;
}

.be-field__input { border-radius: var(--radius-1); }
.be-field__select { border-radius: var(--radius-2); }
`

/**
 * The below-fold reveal, authored once for both directions.
 *
 * The inline component of the movement is multiplied by `--dir`, which is `1` under `dir="ltr"` and
 * `-1` under `dir="rtl"` (`tokens/scale.ts`). That is the whole RTL mechanism: one keyframe set, two
 * directions, numerically mirrored transforms. The alternative — a second `@keyframes` named `-rtl` and
 * a `[dir="rtl"]` rule to select it — is two animations to keep in step, and `pnpm layout` rejects it.
 *
 * `--move-*` is zeroed by the reduced-motion token override, so movement disappears and the opacity
 * cross-fade survives without a per-component branch.
 *
 * Reveals are below the fold only. docs/08 §5 bans entrance animations above it: an element at
 * `opacity: 0` is not painted, and a 500ms fade on the hero h1 costs about 0.7s of LCP.
 */
export const MOTION_CSS = `
@keyframes be-reveal {
  from {
    opacity: 0;
    transform: translate(calc(var(--move-lg) * var(--dir)), var(--move-md));
  }
  to {
    opacity: 1;
    transform: translate(0, 0);
  }
}

[data-reveal] {
  animation: be-reveal var(--dur-reveal) var(--ease-out-soft) both;
}
`

/** A disclosure, which is here because a `<summary>` is a touch target and rarely treated as one. */
export const DISCLOSURE_CSS = `
.be-disclosure { border-block-start: 1px solid var(--color-hairline); }

/* Two rows of an accordion are two targets. Without this they are flush, and docs/08 §4 asks for 8px
   between neighbours — a thumb aiming at the join opens whichever one it lands on. */
.be-disclosure + .be-disclosure { margin-block-start: var(--space-4); }

.be-disclosure__summary {
  display: flex;
  align-items: center;
  min-block-size: 48px;
  padding-block: var(--space-4);
  cursor: pointer;
  font-weight: 600;
}
`

/** The whole system, in the order a cascade wants it: layout, then components, then state. */
export const DESIGN_SYSTEM_CSS = [
  GRID_CSS,
  SECTION_CSS,
  MEASURE_CSS,
  ACTION_CSS,
  FIELD_CSS,
  THERAPIST_CARD_CSS,
  SERVICE_ROW_CSS,
  SLOT_GRID_CSS,
  DISCLOSURE_CSS,
  FOCUS_CSS,
  MOTION_CSS,
]
  .join('\n')
  .trim()

/**
 * Puts the system's CSS on the page.
 *
 * `precedence` is what makes React hoist this into `<head>` and render it once however many times it
 * appears in a tree, which is what allows a component to be dropped onto any route without the route
 * having to remember to import a stylesheet.
 */
export function DesignSystemStyles() {
  return (
    <style
      href="berelax-design-system"
      precedence="default"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: a constant assembled from this package's own modules, never user input
      dangerouslySetInnerHTML={{ __html: DESIGN_SYSTEM_CSS }}
    />
  )
}
