/**
 * `/ar/treatments` — the treatments index, in Arabic.
 *
 * A separate route rather than a runtime toggle, for the reason `app/(ar)/ar/page.tsx` records: the language
 * is part of the URL a crawler indexes and a customer shares, and `lang`/`dir` belong to the `(ar)` root
 * layout's `<html>`. It renders the same component as the English index with the Arabic copy, so the two
 * documents cannot drift in structure — which matters here more than anywhere, because the RTL half of every
 * layout assertion is taken against this tree.
 *
 * It is the same registry entry as `/treatments`, which is what makes the `hreflang` sets identical.
 */
import type { Metadata } from 'next'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { pageGraph } from '../../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../../src/seo/structured-data.tsx'
import { MENU_COPY_AR } from '../../../../src/treatments/copy-ar.ts'
import { treatmentPageData } from '../../../../src/treatments/read.ts'
import { RouteNav } from '../../../_routes/route-nav.tsx'
import { TreatmentsIndexBody } from '../../../_treatments/pages.tsx'

export const metadata: Metadata = {
  title: 'الجلسات — BE RELAX Massage Center and Spa',
  description: 'كل الجلسات المدرجة في القائمة، ومدد كل جلسة.',
  ...routeMetadata('treatments', 'ar'),
}

export default async function ArabicTreatmentsIndexPage() {
  const { facts, licenceClass } = await treatmentPageData()
  const graph = pageGraph({
    id: 'treatments',
    locale: 'ar',
    facts,
    licenceClass,
    breadcrumb: { home: MENU_COPY_AR.home, page: MENU_COPY_AR.title },
    includeCatalogue: true,
  })
  return (
    <>
      <StructuredData graph={graph} />
      <RouteNav id="treatments" locale="ar" />
      <TreatmentsIndexBody facts={facts} copy={MENU_COPY_AR} locale="ar" />
    </>
  )
}
