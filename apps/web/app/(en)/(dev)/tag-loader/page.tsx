import type { Metadata } from 'next'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import {
  TagLoaderFixture,
  type TagLoaderFixtureCopy,
} from '../../../_analytics/tag-loader-fixture.tsx'

/**
 * `/tag-loader` — the consent-gated tag loader and the web-vitals reporter, in English. A-MEAS-04.
 *
 * A development surface like the kitchen sink, the hero demo and the collector fixture, so `indexable:
 * false` in the registry — which is where the `robots` directive and the alternate set both come from, and
 * which also makes this path a noindex prefix for both locales without a second list.
 *
 * `force-dynamic` so the route is never prerendered, for the collector fixture's reason: this route's
 * client-JS budget (`tag-loader-client-js` in `build/budgets.json`) is measured off its own
 * `page_client-reference-manifest.js`, and a static page is the one shape where a future optimisation
 * might fold the route into another entry — at which point the budget would be measuring something else
 * while still passing.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Tag loader fixture — a tag that loads only after a grant',
  description:
    'One declared client tag, gated by the single consent gate, and the web-vitals reporter beside it, so ' +
    'the browser suite can prove that nothing loads before a grant and that something does load after one.',
  ...routeMetadata('tag-loader', 'en'),
}

const COPY: TagLoaderFixtureCopy = {
  heading: 'One tag, and the one decision that lets it load.',
  lede:
    'The tag on this page is first-party and nothing serves it: the suite intercepts the request, which ' +
    'is how "a tag loaded" is asserted without naming a vendor. Whether it may load is ' +
    'mayLoadClientTag — the same function a server-side dispatch is gated on — asked of this document’s ' +
    'own cookie. Nothing here reads the banner’s attribute, and nothing here decides anything.',
  interactLabel: 'Press me, so the page has an interaction to measure',
  shiftLabel: 'A paragraph, so a layout shift has something to be attributed to.',
}

export default function TagLoaderFixturePage() {
  return <TagLoaderFixture copy={COPY} locale="en" />
}
