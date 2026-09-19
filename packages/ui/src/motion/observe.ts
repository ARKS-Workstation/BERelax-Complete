/**
 * The `IntersectionObserver` fallbacks for the two scroll-driven effects.
 *
 * docs/08 §7: scroll effects are `animation-timeline: scroll()`/`view()`, "with an IntersectionObserver
 * fallback that toggles a class once and disconnects". Both halves of that sentence are here, and they
 * are deliberately *different shapes*, which is the one thing worth reading before changing either:
 *
 * - **A reveal is a one-shot.** Content arrives once. Each element is unobserved the moment it has
 *   arrived, and the observer disconnects when the last one has, so a page with fourteen reveals ends
 *   with zero observers rather than fourteen live callbacks competing with the scroll.
 * - **A condensed header is a state.** It has to come back when the reader returns to the top, so its
 *   observer stays connected and toggles in both directions. A one-shot there would condense the header
 *   once and leave it condensed at the top of the page, which says "you have moved" when you have not.
 *
 * ## No DOM globals
 *
 * Every dependency is a parameter: the elements, and the constructor. That is what lets the unit suite
 * drive both functions with a stubbed observer in a Node environment (`environment: 'node'` in
 * `vitest.config.ts`) and assert the thing that actually matters — that `disconnect()` is called after
 * the first intersection and *not before* — without a browser and without jsdom. A fallback whose only
 * test is "the page looks right in Chromium" is a fallback tested in the one browser that never runs it.
 */

/** What these functions need of an element. A real `Element` satisfies it. */
export interface ObservedElement {
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  hasAttribute(name: string): boolean
}

/** What they need of an entry. A real `IntersectionObserverEntry` satisfies it. */
export interface ObservedEntry {
  readonly target: ObservedElement
  readonly isIntersecting: boolean
}

/** What they need of an observer. A real `IntersectionObserver` satisfies it. */
export interface Observer {
  observe(target: ObservedElement): void
  unobserve(target: ObservedElement): void
  disconnect(): void
}

export interface ObserverOptions {
  readonly rootMargin?: string
  readonly threshold?: number
}

export type ObserverFactory = (
  callback: (entries: readonly ObservedEntry[], observer: Observer) => void,
  options?: ObserverOptions,
) => Observer

/** The attribute the fallback adds to a revealed element. `motion/tokens.css` runs the animation on it. */
export const REVEALED_ATTRIBUTE = 'data-revealed'

/** The attribute the fallback adds to a condensed header. */
export const CONDENSED_ATTRIBUTE = 'data-condensed'

/** Everything the reveal applies to, so the island and the stylesheet agree on one selector. */
export const REVEAL_SELECTOR = '[data-reveal]'

/**
 * Start the reveal a little before the element is fully in view.
 *
 * `view()` in CSS begins the reveal at `entry 0%` — the moment the leading edge crosses the viewport
 * edge — so the fallback starts at the same place rather than waiting for the element to be properly
 * on screen, where the reader would watch it fade in after it had already arrived.
 */
export const REVEAL_ROOT_MARGIN = '0px 0px -10% 0px'

/**
 * Reveal each element once, then stop watching.
 *
 * Returns the observer so a caller can disconnect on unmount, or `undefined` when there was nothing to
 * watch — no observer is created for an empty page, because an observer with no targets is a callback
 * that fires once with an empty list and then lives forever.
 */
export function revealOnFirstIntersection(
  targets: readonly ObservedElement[],
  createObserver: ObserverFactory,
): Observer | undefined {
  // Elements already revealed — by a previous mount, or by the scroll timeline before the island loaded
  // — are not observed again. Otherwise a remount re-hides content that has arrived.
  const pending = targets.filter((target) => !target.hasAttribute(REVEALED_ATTRIBUTE))
  if (pending.length === 0) return undefined

  let remaining = pending.length
  const observer = createObserver(
    (entries, self) => {
      let revealedInThisCallback = false
      for (const entry of entries) {
        // `isIntersecting` is the whole condition. An observer fires once at registration with
        // `isIntersecting: false` for everything below the fold, so a callback that revealed on *any*
        // entry would reveal the entire page immediately — and would still pass a test that only checked
        // that `disconnect` had been called.
        if (!entry.isIntersecting) continue
        if (entry.target.hasAttribute(REVEALED_ATTRIBUTE)) continue
        entry.target.setAttribute(REVEALED_ATTRIBUTE, '')
        self.unobserve(entry.target)
        remaining -= 1
        revealedInThisCallback = true
      }
      // Both halves matter. `remaining <= 0` alone disconnects again on every later callback — entries
      // are queued, so a second one can arrive for an element already revealed — and `revealedInThisCallback`
      // alone would disconnect while elements were still waiting.
      if (revealedInThisCallback && remaining <= 0) self.disconnect()
    },
    { rootMargin: REVEAL_ROOT_MARGIN },
  )

  for (const target of pending) observer.observe(target)
  return observer
}

/**
 * Condense a header while a sentinel at the top of the document is off screen.
 *
 * The sentinel rather than a scroll listener: a scroll handler runs on every frame of every scroll for
 * the life of the page, and this needs to know about exactly two moments. It stays connected on purpose
 * — see the note at the top of this file.
 */
export function condenseWhileSentinelIsOffScreen(
  sentinel: ObservedElement,
  header: ObservedElement,
  createObserver: ObserverFactory,
): Observer {
  const observer = createObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) header.removeAttribute(CONDENSED_ATTRIBUTE)
      else header.setAttribute(CONDENSED_ATTRIBUTE, '')
    }
  })
  observer.observe(sentinel)
  return observer
}
