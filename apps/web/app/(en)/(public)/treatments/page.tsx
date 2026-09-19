/**
 * `/treatments` — the treatments index, in English.
 *
 * Generated from the catalogue at build time and replaced by on-demand revalidation when a treatment is
 * published, renamed, repriced or archived (`src/revalidate/catalogue.ts`). The registry declares it
 * `rendering: 'isr'` and `route-spine.itest.ts` checks that claim against `.next/prerender-manifest.json`.
 *
 * It is also the page every archived treatment 301s to — `TREATMENTS_INDEX_PATH` in `@berelax/db`, written
 * by `archiveService` in the same transaction that withdraws the service. A redirect target that does not
 * exist is a 404 with extra steps, which is why this route had to land with the treatment page rather than
 * after it.
 *
 * The JSON-LD publishes the **whole menu** here: this page's subject *is* the menu, which is the one case
 * `includeCatalogue` is for. A treatment page passes its own slug instead.
 */
import type { Metadata } from 'next'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { pageGraph } from '../../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../../src/seo/structured-data.tsx'
import { MENU_COPY_EN } from '../../../../src/treatments/copy-en.ts'
import { treatmentPageData } from '../../../../src/treatments/read.ts'
import { RouteNav } from '../../../_routes/route-nav.tsx'
import { TreatmentsIndexBody } from '../../../_treatments/pages.tsx'

export const metadata: Metadata = {
  title: 'Treatments — BE RELAX Massage Center and Spa',
  description: 'Every treatment on the menu, with the duration options for each.',
  ...routeMetadata('treatments', 'en'),
}

export default async function TreatmentsIndexPage() {
  // One read for the page and its graph. `pageGraph` rather than `readGraphForPage`, which would read the
  // same rows a second time — and a graph built from a second read can describe a different catalogue from
  // the one the page rendered.
  const { facts, licenceClass } = await treatmentPageData()
  const graph = pageGraph({
    id: 'treatments',
    locale: 'en',
    facts,
    licenceClass,
    breadcrumb: { home: MENU_COPY_EN.home, page: MENU_COPY_EN.title },
    includeCatalogue: true,
  })
  return (
    <>
      <StructuredData graph={graph} />
      <RouteNav id="treatments" locale="en" />
      <TreatmentsIndexBody facts={facts} copy={MENU_COPY_EN} locale="en" />
    </>
  )
}
