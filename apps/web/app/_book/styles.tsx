/**
 * The booking page's own CSS, and the one element that puts it on the page.
 *
 * Authored in a template literal beside the components, for the three reasons
 * `packages/ui/src/layout/styles.tsx` gives — a rule has to be readable back out of
 * `document.styleSheets`, a component's rules ship with the component, and React hoists one `<style>`
 * per `href` however many times it is rendered.
 *
 * It lives in `apps/web` rather than in `packages/ui/src/patterns` because none of it is reusable yet:
 * the day strip and the picker exist on exactly one route. The one piece that *is* reusable — the slot
 * grid and its 3/4/6 container queries — is already in `@berelax/ui/patterns` and is not restated here.
 *
 * Every colour is a token. `pnpm colours` rejects a literal hex outside the token layer, and the rule
 * that matters most on this page is the second one it enforces: `--color-decor-gold`, `--color-decor-tan`
 * and `--color-surface-clay` are surfaces, and docs/14 §5 names them as the single most likely defect in
 * this build because the prototype used the bright gold for text. Nothing here sets a `color` to one of
 * the three, and `book.itest.ts` walks every text node on the rendered route and asserts it — because a
 * grep over this file would also pass on a rule somebody commented out.
 *
 * No `@media (min-width`, no `box-shadow` and no `prefers-reduced-motion` block: layout that answers to a
 * container belongs to a container query, elevation is one token for overlays, and reduced motion is a
 * token override in `packages/ui/src/tokens/scale.ts`. `pnpm layout` fails on all three.
 */

export const BOOK_CSS = `
/* The day strip. A row of trading dates, each one a submit button, so choosing a day works with
   JavaScript off and the URL that comes back is shareable. */
.be-book__days {
  display: flex;
  flex-wrap: wrap;
  /* 12px, comfortably over docs/08 §4's 8px minimum between targets. Wrapping rather than scrolling:
     a horizontal scroller at 390px hides its own ends, and a reader cannot tell there is a Thursday. */
  gap: var(--space-4);
  margin: 0;
  padding: 0;
  list-style: none;
}

.be-book__day {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  /* Both floors stated, not arrived at through padding. docs/08 §4: 48px on mobile. */
  min-block-size: 48px;
  min-inline-size: 48px;
  padding-inline: var(--space-5);
  padding-block: var(--space-3);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-2);
  background: var(--color-surface);
  color: var(--color-ink);
  font: inherit;
  font-variant-numeric: tabular-nums;
  text-align: center;
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease-calm);
}

.be-book__day:hover { background: var(--color-ground-sunk); }

/* The chosen day. The same fill pair as the primary action and the chosen slot, which docs/08 §2
   measures: --color-accent-gold behind --color-ground. */
.be-book__day[aria-current='date'] {
  background: var(--color-accent-gold);
  color: var(--color-ground);
  border-color: var(--color-accent-gold);
}

/*
 * The flow's own container, and the one measurement the slot grid's column count depends on.
 *
 * SlotGrid answers to ITS container: 3 columns under 360px, 4 from 360, 6 from 520 (SLOT_GRID_COLUMNS).
 * Those widths are a booking sheet's, not a page's — so the grid only reaches all three of them if the
 * column it sits in changes width, which is what this does:
 *
 *   - under 600px of flow the page is one column and the picker gets the whole editorial "wide" span:
 *     350px at a 390px viewport, which is 3 columns;
 *   - from 600px the form moves beside the times, taking a 16rem track: about 400px of picker at a 768px
 *     viewport (4 columns) and about 800px at 1440 (6 columns).
 *
 * A container query and not a media query, because the question is how much room the flow has and not how
 * wide the window is — the same reason therapist-card.tsx gives. It needs a NAMED container on an
 * ANCESTOR: a container query cannot ask about the element it is applied to, so .be-book carries the
 * containment and .be-book__flow is what responds to it. Written the other way round the rule silently
 * never matches, and the page renders one column at every width.
 */
.be-book {
  container-type: inline-size;
  container-name: book;
}

.be-book__flow { display: flex; flex-direction: column; gap: var(--space-8); }

@container book (min-width: 600px) {
  .be-book__flow {
    display: grid;
    grid-template-columns: minmax(0, 16rem) minmax(0, 1fr);
    align-items: start;
  }
}

.be-book__column { display: flex; flex-direction: column; gap: var(--space-7); }
.be-book__stack { display: flex; flex-direction: column; gap: var(--space-7); }
.be-book__fields { display: flex; flex-direction: column; gap: var(--space-7); }

.be-book__fieldset {
  border: 0;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.be-book__legend {
  padding: 0;
  font-weight: 600;
}

/* 17px, from the type scale, and the reason is iOS: a control below 16px makes Safari zoom the page on
   focus, which throws the layout away mid-booking. docs/09 §3 states the floor; this is where it is
   true, and \`book.itest.ts\` reads the computed size off every control on the route. */
.be-book__select {
  min-block-size: 48px;
  padding-inline: var(--space-5);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-2);
  background: var(--color-surface);
  color: var(--color-ink);
  font-family: inherit;
  font-size: var(--text-base);
}

.be-book__note { color: var(--color-ink-2); font-size: var(--text-sm); margin: 0; }
.be-book__group { display: flex; flex-direction: column; gap: var(--space-5); }
.be-book__group-heading { margin: 0; font-size: var(--text-sm); color: var(--color-ink-2); }

/* A designed state, never an empty container: a bordered panel with a heading, so "nothing is free"
   looks like an answer rather than like a page that failed to load.

   --color-ground-sunk and not --color-surface, and the reason is measured rather than aesthetic. The
   nearest-day links inside this panel are .be-action--quiet, which is --color-accent-teal on the panel's
   own background: in the dark theme that measures 4.22:1 against --color-surface and 4.82:1 against
   --color-ground-sunk, which is the darker of the two. docs/08 §2 measures every accent against the
   GROUND, so an accent moved onto a raised surface loses contrast the table does not mention — axe found
   it on the dark RTL render of this page. A recessed band is also what docs/08 §2 lists --ground-sunk
   for. (No hex here on purpose: pnpm colours reads a literal inside this template as a colour somebody
   chose, and it is right to.) */
.be-book__state {
  border: 1px solid var(--color-hairline);
  border-radius: var(--radius-1);
  background: var(--color-ground-sunk);
  padding: var(--space-7);
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.be-book__region { display: flex; flex-direction: column; gap: var(--space-4); }
.be-book__region-heading { margin: 0; font-size: var(--text-base); }
.be-book__list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--space-4); }

/* A row that is not a link — an alternative therapist has no page to go to until W-SITE-06 publishes
   one, and a link to nowhere is worse than a line of text. */
.be-book__row {
  border-block-start: 1px solid var(--color-hairline);
  padding-block: var(--space-4);
  color: var(--color-ink);
}

/* Text for assistive technology only: the live region, and the internal reference that tells two
   unnamed therapists apart. Clipped rather than \`display: none\`, which would take it out of the
   accessibility tree along with everything it says — and clipped rather than off-flow for a second
   reason: the announcement must not move a single pixel, or every screenshot in the matrix would depend
   on whether hydration had finished. */
.be-book__hidden {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}
`

/**
 * Puts the booking page's CSS on the page.
 *
 * `precedence` is what makes React hoist it into `<head>` and render it once, so the island and the
 * server-rendered body do not each ship a copy.
 */
export function BookStyles() {
  return (
    <style
      href="berelax-book"
      precedence="default"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: a constant from this module, never user input
      dangerouslySetInnerHTML={{ __html: BOOK_CSS }}
    />
  )
}
