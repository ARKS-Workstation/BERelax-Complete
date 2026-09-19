/**
 * `/pricing` — every price, in one table, in English.
 *
 * A route of its own rather than a section of the index, because it is the page a customer sends a friend and
 * the page an assistant is asked to quote from. docs/09 §"LLM SEO" asks for "tables for comparable facts",
 * and this is that table: 8 treatments × 4 durations, plus the three offerings docs/13 §4 prints with no
 * figure at all.
 *
 * Every figure comes from the fact sheet, through the money helper, from the row that is in force today —
 * including an effective-dated `price_list` row, which is what a price change through the admin writes. The
 * page cannot show a figure the desk would not charge, because there is only one read.
 */
import type { Metadata } from 'next'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { pageGraph } from '../../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../../src/seo/structured-data.tsx'
import { MENU_COPY_EN } from '../../../../src/treatments/copy-en.ts'
import { treatmentPageData } from '../../../../src/treatments/read.ts'
import { RouteNav } from '../../../_routes/route-nav.tsx'
import { PricingBody } from '../../../_treatments/pages.tsx'

export const metadata: Metadata = {
  title: 'Prices — BE RELAX Massage Center and Spa',
  description: 'Every treatment at every duration, gross and VAT-inclusive.',
  ...routeMetadata('pricing', 'en'),
}

export default async function PricingPage() {
  const { facts, licenceClass } = await treatmentPageData()
  const graph = pageGraph({
    id: 'pricing',
    locale: 'en',
    facts,
    licenceClass,
    breadcrumb: { home: MENU_COPY_EN.home, page: MENU_COPY_EN.pricingTitle },
    // The whole menu, including the price-on-request offerings: this page's subject is the price list.
    includeCatalogue: true,
  })
  return (
    <>
      <StructuredData graph={graph} />
      <RouteNav id="pricing" locale="en" />
      <PricingBody facts={facts} copy={MENU_COPY_EN} locale="en" />
    </>
  )
}
