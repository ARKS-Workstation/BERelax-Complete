import type { Metadata } from 'next'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import {
  CollectorFixture,
  type CollectorFixtureCopy,
} from '../../../_analytics/collector-fixture.tsx'

/**
 * `/collector` — the collector fixture, in English. A-FIRST-06.
 *
 * A development surface like the kitchen sink and the hero demo, so `indexable: false` in the registry,
 * which is where the `robots` directive and the alternate set both come from — a dev route cannot become
 * indexable by a page forgetting to restate it.
 *
 * `force-dynamic` so the route is never prerendered. Not for a data reason: this page reads nothing. It is
 * because the collector's budget (`collector-client-js` in `build/budgets.json`) is measured off this
 * route's `page_client-reference-manifest.js`, and the one thing that must stay true of this page is that
 * the only client JavaScript on it is the collector. A static page is the one shape where a future
 * optimisation might fold the route into another entry, and the budget would then be measuring something
 * else while still passing.
 */
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Collector fixture — declared interactions and the batch they produce',
  description:
    'One element per declarable event in the measurement taxonomy, so the browser suite can prove that ' +
    'each declared interaction produces exactly one collected event.',
  ...routeMetadata('collector', 'en'),
}

const COPY: CollectorFixtureCopy = {
  eyebrow: 'BE RELAX — measurement',
  heading: 'Every event the markup can declare, on one page.',
  lede:
    'Tracking is declared on the element: an attribute names the event and one attribute per payload ' +
    'field carries the rest. Nothing on this page is a component that knows it is tracked, and the ' +
    'collector holds no list of event names — it reads the taxonomy, and a name the taxonomy does not ' +
    'hold fails the build rather than reaching the server.',
  interactionsHeading: 'One control per declarable event',
  whatsapp: 'WhatsApp call to action',
  call: 'Telephone call to action',
  book: 'Booking call to action',
  service: 'A service was read',
  price: 'A price was read',
  twiceHeading: 'The same control, clicked twice',
  twice:
    'A reader who taps a control twice because nothing visibly happened has done one thing, and a click ' +
    'handler that fires on both halves of a double click has seen two. The second firing inside 300 ms ' +
    'is refused by name, and the control beside this one declares no event at all — so a listener that ' +
    'tracked every click on the page would fail that assertion rather than pass this one.',
  twiceLabel: 'Click me twice',
  undeclared: 'Declares nothing',
}

export default function CollectorFixturePage() {
  return <CollectorFixture copy={COPY} locale="en" />
}
