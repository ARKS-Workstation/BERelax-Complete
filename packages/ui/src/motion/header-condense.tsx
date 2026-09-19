'use client'

/**
 * Island 2 of 2: the header condensation's fallback, plus the sentinel it watches.
 *
 * Like the reveal, the effect itself is CSS — `animation-timeline: scroll()` on `.be-header` — and this
 * is only for a browser without it. Unlike the reveal, nothing is held back there: an un-condensed
 * header is a correct header, so this island adds a behaviour rather than releasing one, and a browser
 * with no scroll timelines and no JavaScript simply gets a header that does not condense.
 *
 * ## The sentinel, and why not a scroll listener
 *
 * A `scroll` handler runs on every frame of every scroll for the life of the page, and this needs to
 * know about exactly two moments: the header's own height of scroll, passed and un-passed. So the island
 * renders a sentinel that is one header tall with an equal negative margin — zero layout impact, the
 * same threshold as the CSS `animation-range`, one token — and an `IntersectionObserver` reports when it
 * leaves and re-enters the viewport. docs/08 §8 is explicit that scroll smoothness on mid-tier Android
 * is the constraint here, and it is most of the traffic.
 *
 * The observer deliberately **stays connected**: a condensed header is a state that has to come back at
 * the top of the page, not an arrival. `motion/observe.ts` has the two shapes side by side.
 */
import { useEffect, useRef } from 'react'
import { scrollTimelineSupported } from './bootstrap.ts'
import { condenseWhileSentinelIsOffScreen } from './observe.ts'

export interface HeaderCondenseProps {
  /** The header to condense. Defaults to the class `motion/tokens.css` styles. */
  readonly headerSelector?: string
}

export default function HeaderCondense({ headerSelector = '.be-header' }: HeaderCondenseProps) {
  const sentinel = useRef<HTMLSpanElement | null>(null)

  useEffect(() => {
    if (scrollTimelineSupported((property, value) => CSS.supports(property, value))) return
    const element = sentinel.current
    const header = document.querySelector(headerSelector)
    // A page with no header is not a failure: this island is dropped onto a route by the layout that has
    // one, and a route that does not render a header still renders the sentinel harmlessly.
    if (element === null || header === null) return
    const observer = condenseWhileSentinelIsOffScreen(
      element,
      header,
      (callback, options) => new IntersectionObserver(callback, options),
    )
    return () => observer.disconnect()
  }, [headerSelector])

  // `aria-hidden` and empty: it is a scroll position, not content. It is rendered on the server so the
  // observer has something to watch on the first frame after hydration rather than after a second paint.
  return <span ref={sentinel} className="be-header-sentinel" aria-hidden="true" />
}
