/**
 * `/ar/pricing` — every price, in one table, in Arabic.
 *
 * The same component and the same figures as `/pricing`: docs/08 §7 chose Latin numerals for Arabic
 * (`ar-AE-u-nu-latn`), which is UAE commercial practice, so the two documents publish byte-identical amounts
 * and a customer comparing them across languages sees one price list rather than two.
 */
import type { Metadata } from 'next'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { pageGraph } from '../../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../../src/seo/structured-data.tsx'
import { MENU_COPY_AR } from '../../../../src/treatments/copy-ar.ts'
import { treatmentPageData } from '../../../../src/treatments/read.ts'
import { RouteNav } from '../../../_routes/route-nav.tsx'
import { PricingBody } from '../../../_treatments/pages.tsx'

export const metadata: Metadata = {
  title: 'الأسعار — BE RELAX Massage Center and Spa',
  description: 'كل جلسة بكل مدة، بمبلغ إجمالي شامل ضريبة القيمة المضافة.',
  ...routeMetadata('pricing', 'ar'),
}

export default async function ArabicPricingPage() {
  const { facts, licenceClass } = await treatmentPageData()
  const graph = pageGraph({
    id: 'pricing',
    locale: 'ar',
    facts,
    licenceClass,
    breadcrumb: { home: MENU_COPY_AR.home, page: MENU_COPY_AR.pricingTitle },
    includeCatalogue: true,
  })
  return (
    <>
      <StructuredData graph={graph} />
      <RouteNav id="pricing" locale="ar" />
      <PricingBody facts={facts} copy={MENU_COPY_AR} locale="ar" />
    </>
  )
}
