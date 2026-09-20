/**
 * The hero's CSS, and the three decisions in it that a comment has to carry.
 *
 * Authored as a string for the reasons `layout/styles.tsx` gives: a rule has to be readable back out of
 * `document.styleSheets`, a component's rules ship with the component, and React hoists one `<style>`
 * element per `href` however many heroes a page renders.
 *
 * ## The video is NOT rendered at `opacity: 0`
 *
 * docs/08 §6 asks for a cross-fade on the `playing` event — "opacity 0→1, 320ms" — and the obvious way to
 * get one is to author the video at `opacity: 0` and let the island raise it. That is wrong here, and the
 * acceptance criterion this unit is held to is what says so: *no element above the fold may have a
 * computed opacity below 1 at first paint*. A server-rendered `opacity: 0` breaks it for real rather than
 * on a technicality — with JavaScript off, a blocked chunk or a deploy that 404s, the page permanently
 * carries an invisible element over its own hero, which is the failure mode `motion/bootstrap.ts` had to
 * add a three-second failsafe for.
 *
 * So the transparency is the **island's** first act, not the document's: `data-hero-state="attaching"`
 * takes the video to 0, the source is attached, and `playing` takes it back to 1 over `--dur-slow`. A
 * `<video>` with no `src` and no `poster` paints nothing at all, so at `opacity: 1` before the island runs
 * it is invisible either way — the only difference is which of the two failure modes the page has.
 *
 * ## The cross-fade duration is the token, not 320ms
 *
 * `--dur-slow` **is** 320ms (`tokens/scale.ts`, docs/08 §5's "accordion, sheet, dialog, page"), so reading
 * the token is not an approximation of docs/08 §6's number — it is the same number, once. It also means
 * the fade is inside the reduced-motion override rather than beside it, which costs nothing here (under
 * reduced motion nothing is ever attached) and is the property that stops this being the one animation on
 * the site that ignores the setting.
 *
 * ## Why this stylesheet owns `--hero-video` and not a second blur
 *
 * The island has to know about `prefers-reduced-transparency`, and a token is how it asks: `--hero-video`
 * is `1` normally and `0` inside the query, and `attach-video.ts` reads it. The blur, by contrast, is
 * **not** re-declared: `--hero-control-blur` is `var(--header-blur)`, which the motion stylesheet already
 * declares as 8px and already drops to 0px in its own `prefers-reduced-transparency` block. docs/08 §8
 * states the 8px maximum once and this reads it, so the control cannot end up blurrier than the header or
 * keep a blur the header has dropped.
 *
 * (The token is named for the header because that is the paint docs/08 §8 budgets. `--blur-overlay` would
 * be the better name now that a second element reads it, and renaming it belongs to whoever owns
 * `motion/tokens.css` rather than to this file.)
 */
import { DURATION, TOUCH_TARGET } from '../tokens/scale.ts'
import { HERO_CONTROL_ATTRIBUTE, HERO_STATE_ATTRIBUTE } from './attach-video.ts'

/**
 * The hero's stylesheet.
 *
 * `overflow: clip` rather than `hidden`: the two crop identically and `clip` creates no scroll container,
 * so an in-page anchor inside the hero cannot be scrolled out of reach by a stray focus.
 */
export const HERO_MEDIA_CSS = `
:root {
  /* docs/08 §6 gives the control an 8px backdrop blur. That number and its reduced-transparency
     override are both declared by \`--header-blur\` in motion/tokens.css; this is a read, not a copy. */
  --hero-control-blur: var(--header-blur);
  /* Whether a moving hero is wanted at all. Read by the island through \`--hero-video\`. */
  --hero-video: 1;
}

@media (prefers-reduced-transparency: reduce) {
  :root {
    /* A moving photograph under the scrim the headline's contrast was measured against is the
       transparency problem with a time axis: the measured ratio holds for one frame of it. */
    --hero-video: 0;
  }
}

.be-hero {
  position: relative;
  display: block;
  overflow: clip;
  /* The box is reserved by the poster's own \`.slot-picture\` rule, at the ladder's two ratios. Nothing
     here states a ratio: an art-directed slot is served at 4:5 below 768px and 16:9 above it, and one
     \`aspect-ratio\` would reserve the desktop box and hand it the phone's crop. */
  background: var(--color-ground-sunk);
}

.be-hero__video {
  position: absolute;
  inset: 0;
  z-index: 1;
  inline-size: 100%;
  block-size: 100%;
  /* The rendition is 16:9 or 4:5 and so is the box it covers, so this crops nothing in practice — it is
     here so that a rendition re-cut to another shape is letterboxed rather than stretched. */
  object-fit: cover;
}

/*
 * The one state in which the video is transparent, and it is the island that puts it there.
 *
 * No transition on the way DOWN, and that is the whole reason the transition is declared on the two
 * states below rather than on the element. An element with no src and no poster paints nothing, so fading
 * it out is one duration of animating something invisible — and it is worse than pointless: the first
 * frame arrives while that fade is still in flight, so the cross-fade docs/08 section 6 asks for would
 * start from wherever the fade-out had got to rather than from zero. Measured before it was written down:
 * with a cached rendition the video reached playing about a tenth of a second after attaching and faded in
 * from 0.8, which looks like no cross-fade at all.
 */
.be-hero[${HERO_STATE_ATTRIBUTE}="attaching"] .be-hero__video {
  opacity: 0;
}

/* docs/08 §6's cross-fade, as the token that is that number, in the direction that is visible. */
.be-hero[${HERO_STATE_ATTRIBUTE}="playing"] .be-hero__video,
.be-hero[${HERO_STATE_ATTRIBUTE}="paused"] .be-hero__video {
  opacity: 1;
  transition: opacity var(--dur-slow) linear;
}

.be-hero__control {
  position: absolute;
  z-index: 2;
  /* docs/08 §6: bottom inline-end. Logical, so the Arabic document puts it bottom-left without a rule
     of its own. */
  inset-block-end: var(--space-6);
  inset-inline-end: var(--space-6);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  /* WCAG 2.5.5 asks for 44x44; docs/08 §4 asks for ${TOUCH_TARGET.mobile} on a phone, which is the larger
     of the two and therefore the one that satisfies both. Stated as the token so the floor moves in one
     place. */
  min-inline-size: ${TOUCH_TARGET.mobile}px;
  min-block-size: ${TOUCH_TARGET.mobile}px;
  padding: 0;
  border: 1px solid var(--color-hairline);
  border-radius: var(--radius-handle);
  /* docs/08 §6 gives the control a white fill at 72% alpha. It is written as the surface token mixed
     towards transparent at that alpha rather than as the literal: a literal is a colour nobody derived
     and nobody measured, and it would also stay white on the dark theme's ground. */
  background: color-mix(in oklab, var(--color-surface) 72%, transparent);
  backdrop-filter: blur(var(--hero-control-blur));
  color: var(--color-ink);
  cursor: pointer;
  /* Colour only. docs/08 §5: hover is 140ms of colour, and nothing moves. */
  transition: background-color var(--dur-fast) var(--ease-calm);
}

.be-hero__control:hover {
  background: color-mix(in oklab, var(--color-surface) 88%, transparent);
}

/*
 * One control, two glyphs, and the state decides which is drawn.
 *
 * Both are in the markup because the island must be able to swap them without knowing the locale or
 * building an element — everything it changes is one attribute, which is also what keeps it inside its
 * budget. \`display: none\` rather than \`visibility\`, so the hidden one is out of the flex line.
 */
.be-hero__control [data-hero-glyph] {
  display: none;
}

.be-hero__control[${HERO_CONTROL_ATTRIBUTE}="pause"] [data-hero-glyph="pause"],
.be-hero__control[${HERO_CONTROL_ATTRIBUTE}="play"] [data-hero-glyph="play"] {
  display: block;
}
`.trim()

/**
 * The cross-fade's duration in milliseconds, for the one assertion that has to know it.
 *
 * Exported from here rather than restated in a test: docs/08 §6 says 320ms, `--dur-slow` is 320ms, and a
 * test that wrote \`320\` would pass on a stylesheet that had stopped using the token.
 */
export const HERO_CROSS_FADE_MS = Number.parseInt(DURATION.slow, 10)
