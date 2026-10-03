'use client'

// The zod-free leaf, not `@berelax/shared` and not `./collect.ts`: both of those import zod, and this is
// a client module. See `packages/shared/src/analytics/dimensions.ts` for the 106,765 bytes that found it.
import { breakpointFor } from '@berelax/shared/analytics/dimensions'
import { attachWebVitals, identifiableFrom } from '@berelax/ui/analytics'
import { flushCollector, trackCollectorEvent } from '@berelax/ui/analytics/collector-island'
import { useEffect } from 'react'

/**
 * The web-vitals reporter's one client boundary (A-MEAS-04). Renders nothing.
 *
 * ## Why it is here and not in `packages/ui`
 *
 * The same division `collector.client.tsx`'s absence records: `packages/ui/src/analytics/*` is typechecked
 * by the root project and holds no React module, so the file that owns a `PerformanceObserver`'s lifetime
 * through `useEffect` belongs in the application. What is in `packages/ui` is the arithmetic and the
 * identity rule, which is where they can be tested without a browser.
 *
 * ## Why it reuses the collector rather than creating one
 *
 * `trackCollectorEvent` and `flushCollector` are the shared collector's own doors. A second
 * `createCollector` here would be a second queue, a second browser host and a second envelope — and that
 * envelope's `interactionCount` would read nought for a page somebody interacted with, because the
 * interactions were counted by the other instance.
 *
 * ## Why the four dimensions are read at REPORT time and not at mount
 *
 * `dimensions()` is a function and it is called once, when the page is being hidden. A visitor who rotated
 * a phone or resized a window between the LCP and leaving the page was laid out at the width they ended
 * at for most of the visit, and the figure that matters is the one the metric was produced under. Reading
 * the width at mount would attribute every metric to the first layout, which on a page that was resized
 * is the layout the reader saw least.
 *
 * The locale and the direction come off the document element rather than from a prop, because that is
 * where `DocumentShell` puts them and it is the only statement of them a browser can see — a prop would be
 * a second copy that a route could get wrong without anything noticing.
 */
export default function WebVitalsIsland({ path }: { readonly path: string }): null {
  useEffect(() => {
    const stop = attachWebVitals({
      collector: { track: trackCollectorEvent, flush: flushCollector },
      dimensions: () => ({
        path,
        breakpoint: breakpointFor(typeof window.innerWidth === 'number' ? window.innerWidth : null),
        locale: document.documentElement.lang === 'ar' ? 'ar' : 'en',
        direction: document.documentElement.dir === 'rtl' ? 'rtl' : 'ltr',
      }),
      observe: (type, options, onEntries) => {
        // A browser that does not know the entry type THROWS from `observe`, and for two years Safari was
        // that browser for `event`. Caught per observer so one unsupported type costs its own metric and
        // not the other four.
        try {
          const observer = new PerformanceObserver((list) => {
            onEntries(list.getEntries())
          })
          /*
            The cast is for `durationThreshold`, which `PerformanceObserverInit` in the TypeScript DOM
            library does not declare although every browser that supports the `event` entry type reads
            it. Without it the observer reports only events over 104 ms — the spec's default — and INP
            would be measured over a fraction of the interactions, reading as a faster page. The cast is
            on the OPTIONS object alone and not on the observer, so a misspelled entry type is still a
            type error.
          */
          observer.observe({
            type,
            buffered: options.buffered,
            ...(options.durationThreshold === undefined
              ? {}
              : { durationThreshold: options.durationThreshold }),
          } as PerformanceObserverInit)
          return () => {
            observer.disconnect()
          }
        } catch {
          return null
        }
      },
      onFinal: (report) => {
        const onHidden = (): void => {
          // The STATE and not the event: a `visibilitychange` back to visible is a tab returning, and a
          // report taken then would be a half-finished one.
          if (document.visibilityState === 'hidden') report()
        }
        document.addEventListener('visibilitychange', onHidden)
        window.addEventListener('pagehide', report)
        return () => {
          document.removeEventListener('visibilitychange', onHidden)
          window.removeEventListener('pagehide', report)
        }
      },
      timeToFirstByte: () => {
        const [navigation] = performance.getEntriesByType('navigation')
        const responseStart = (navigation as { responseStart?: unknown } | undefined)?.responseStart
        return typeof responseStart === 'number' ? responseStart : null
      },
      identify: identifiableFrom,
    })
    return stop
  }, [path])

  return null
}
