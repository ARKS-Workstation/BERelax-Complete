/**
 * The scroll-timeline support test, in the two places that need it, derived from one pair of strings.
 *
 * ## Why a blocking inline script, like the theme's
 *
 * Both scroll-driven effects are pure CSS in a browser that has `animation-timeline` (Chromium and
 * Safari today). In a browser that does not have it — Firefox, as of writing — the declaration is
 * dropped by the parser and `[data-reveal]` becomes an ordinary time-based animation that plays on
 * load, which is not a below-fold reveal at all: it has finished before the reader has scrolled to it.
 *
 * The fallback therefore has to *hold the animation at its first frame* until an
 * `IntersectionObserver` says the element has arrived — and that decision has to be made before the
 * first paint, or the reveal plays, the island hydrates a few hundred milliseconds later, and the
 * reader watches content that was already there disappear and come back. So the support test runs in a
 * blocking inline script in the document head, exactly as `themeBootstrapScript()` does and for the
 * same reason: a correction after hydration is a visible wrong frame.
 *
 * It costs no client JavaScript — it is inline in the HTML, not a module, and it is about 300 bytes —
 * which is what keeps the island budget's "zero bytes attributable to motion in the shared layout"
 * true while the shell still carries this.
 *
 * ## The failsafe, and why hiding content behind JavaScript needs one
 *
 * `data-motion-fallback` makes the stylesheet hold every `[data-reveal]` at `opacity: 0`. If the island
 * that reveals them never arrives — a chunk that 404s after a deploy, a blocked script, a browser that
 * gave up — the page is *permanently blank where its content should be*, and nothing reports it. That
 * failure mode is worse than the one the fallback exists to fix, so the script removes its own attribute
 * if no island has claimed the handshake within three seconds. The reveal then plays on load, which is
 * the degraded behaviour, not a blank page.
 *
 * Pure: it returns a string. No DOM types, so it lives in the root typecheck project with the rest of
 * the motion system's logic.
 */

/** The property and value whose support decides whether the fallback is needed. One spelling, two uses. */
export const SCROLL_TIMELINE_PROPERTY = 'animation-timeline'
export const SCROLL_TIMELINE_VALUE = 'view()'

/** Set on `<html>` when the browser has no scroll-driven animations. Read by `motion/tokens.css`. */
export const MOTION_FALLBACK_ATTRIBUTE = 'data-motion-fallback'

/** Set by an island that has taken charge of the fallback. Cancels the failsafe below. */
export const MOTION_READY_ATTRIBUTE = 'data-motion-ready'

/**
 * How long the fallback waits for an island before assuming one is never coming.
 *
 * Three seconds is long enough to cover hydration on a mid-tier phone on 4G — the slowest case this
 * site is budgeted for — and short enough that a reader who hits the failure sees the content rather
 * than reloading.
 */
export const MOTION_FALLBACK_FAILSAFE_MS = 3000

/**
 * The same support test the islands run, with the capability injected.
 *
 * Injected rather than reaching for the global `CSS`, so it is one pure function the unit suite can
 * drive both ways in a Node environment — and so the island and this script cannot end up asking
 * different questions.
 */
export function scrollTimelineSupported(
  supports: (property: string, value: string) => boolean,
): boolean {
  try {
    return supports(SCROLL_TIMELINE_PROPERTY, SCROLL_TIMELINE_VALUE)
  } catch {
    // `CSS.supports` throws on a malformed pair rather than returning false in some engines. A support
    // test that throws must read as "not supported", never take the page down.
    return false
  }
}

/**
 * The script that runs before first paint.
 *
 * Deliberately total: a `try` around everything, because a browser without `CSS.supports` must get a
 * page rather than an exception, and the whole point of this script is that it cannot be the thing that
 * breaks a document.
 */
export function motionBootstrapScript(): string {
  const supports = `CSS.supports(${JSON.stringify(SCROLL_TIMELINE_PROPERTY)},${JSON.stringify(SCROLL_TIMELINE_VALUE)})`
  return (
    '(function(){try{' +
    `if(${supports})return;` +
    'var d=document.documentElement;' +
    `d.setAttribute(${JSON.stringify(MOTION_FALLBACK_ATTRIBUTE)},'');` +
    `setTimeout(function(){if(!d.hasAttribute(${JSON.stringify(MOTION_READY_ATTRIBUTE)}))` +
    `d.removeAttribute(${JSON.stringify(MOTION_FALLBACK_ATTRIBUTE)})},${MOTION_FALLBACK_FAILSAFE_MS});` +
    '}catch(e){}})()'
  )
}
