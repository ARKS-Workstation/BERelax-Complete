'use client'

/**
 * Island 1 of 2: the below-fold reveal's fallback.
 *
 * ## It does nothing in most browsers, and that is the design
 *
 * The reveal is CSS — `animation-timeline: view()` in `motion/tokens.css` — which means it is
 * compositor-driven, costs no JavaScript, and works with this island absent. This exists only for a
 * browser with no scroll-driven animations, where the blocking script in `motion/bootstrap.ts` has held
 * every `[data-reveal]` at its first frame and something has to let them go.
 *
 * So the first thing it does is ask whether it is needed, and the usual answer is no.
 *
 * ## Why it is dynamically imported, and why that is enforced
 *
 * docs/08 §7 budgets the motion library at "≤2 code-split islands, never in the shared layout". This is
 * one of the two, and `pnpm layout`'s `motion-island-must-be-a-dynamic-client-module` fails the build if
 * anything imports it statically or if a third island appears; `no-motion-in-the-shared-layout` in
 * `.dependency-cruiser.cjs` fails it if the shell or a layout primitive reaches for either. The cost of
 * both is measured, not asserted: `build/budgets.json` carries a per-island gzip budget that
 * `pnpm budgets` reads out of the real build.
 *
 * It renders `null`. An island that renders markup cannot be deferred without moving content out of the
 * server-rendered HTML, and the content on this site is the reason the site exists (ADR 0013).
 */
import { useEffect } from 'react'
import {
  MOTION_FALLBACK_ATTRIBUTE,
  MOTION_READY_ATTRIBUTE,
  scrollTimelineSupported,
} from './bootstrap.ts'
import { REVEAL_SELECTOR, revealOnFirstIntersection } from './observe.ts'

export default function RevealFallback() {
  useEffect(() => {
    if (scrollTimelineSupported((property, value) => CSS.supports(property, value))) return
    const root = document.documentElement
    // Claim the handshake first. The bootstrap removes its own attribute after three seconds if nothing
    // claims it, and that failsafe must be cancelled before it fires rather than after.
    root.setAttribute(MOTION_READY_ATTRIBUTE, '')
    // Already fired — the reveals have played on load, and re-hiding them now would take content off a
    // screen the reader is looking at.
    if (!root.hasAttribute(MOTION_FALLBACK_ATTRIBUTE)) return
    const observer = revealOnFirstIntersection(
      [...document.querySelectorAll(REVEAL_SELECTOR)],
      (callback, options) => new IntersectionObserver(callback, options),
    )
    return () => observer?.disconnect()
  }, [])

  return null
}
