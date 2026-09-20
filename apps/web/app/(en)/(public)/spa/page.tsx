/**
 * `/spa` — the place, in English.
 *
 * Rooms, arrival, parking, transport, hours and the NAP block, every one of them from the `premises` row and
 * nothing else. docs/09 §4 lists `/spa` as one of the three visible surfaces that row drives, and W-SITE-02
 * deferred it here with the note that "cache-tag revalidation belongs to the first ISR route that renders
 * NAP" — this and `/contact` are those routes, and `src/revalidate/content.ts` is that revalidation.
 *
 * `rendering: 'isr'` in the registry: prerendered from the database at build time, replaced on demand when
 * the premises row changes. The alternative was `dynamic`, which would put a database read in front of every
 * crawler visit to a page that changes when the owner changes an opening time.
 */
import type { Metadata } from 'next'
import { renderedStrings, spaSections } from '../../../../src/cms/content.ts'
import { CONTENT_COPY_EN } from '../../../../src/cms/copy-en.ts'
import { assertPageCopyCompliant, contentPageData } from '../../../../src/cms/page-data.ts'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { pageGraph } from '../../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../../src/seo/structured-data.tsx'
import { SpaBody } from '../../../_content/pages.tsx'
import { NAP_COPY_EN } from '../../../_routes/nap-copy.ts'
import { RouteNav } from '../../../_routes/route-nav.tsx'

export const metadata: Metadata = {
  title: 'The spa — BE RELAX Massage Center and Spa',
  description: 'Where the spa is, how to get in, where to park, and when the doors are open.',
  ...routeMetadata('spa', 'en'),
}

export default async function SpaPage() {
  const { facts, licenceClass, policy } = await contentPageData()
  const copy = CONTENT_COPY_EN
  // The rendered copy, linted before it is served — including every value interpolated out of the premises
  // row. A finding throws and the build fails naming the rule; see `src/cms/page-data.ts`.
  assertPageCopyCompliant(
    'spa',
    renderedStrings({
      title: copy.spa.title,
      lede: copy.spa.lede,
      sections: spaSections(copy, { facts, locale: 'en' }),
    }),
    policy,
  )
  const graph = pageGraph({
    id: 'spa',
    locale: 'en',
    facts,
    licenceClass,
    breadcrumb: { home: copy.home, page: copy.spa.title },
    // The subject of this page is the premises, not the menu: a `Service` node per treatment here would be
    // the same information a consumer has to reconcile on every document. See `PageGraphOptions`.
    includeCatalogue: false,
  })
  return (
    <>
      <StructuredData graph={graph} />
      <RouteNav id="spa" locale="en" />
      <SpaBody facts={facts} copy={copy} locale="en" napCopy={NAP_COPY_EN} />
    </>
  )
}
