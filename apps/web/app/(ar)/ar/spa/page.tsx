/**
 * `/ar/spa` — the place, in Arabic.
 *
 * A separate route rather than a runtime toggle, for the reason `app/(ar)/ar/page.tsx` records: the language
 * is part of the URL a crawler indexes and a customer shares, and `lang`/`dir` belong to the `(ar)` root
 * layout's `<html>`. It renders the same component as the English page with the Arabic copy, so the two
 * documents cannot drift in structure — and it is the same registry entry, which is what makes the `hreflang`
 * sets identical. An hreflang set with one locale pointing at a 404 invalidates the whole set, so every route
 * this unit adds is added in both locales.
 */
import type { Metadata } from 'next'
import { renderedStrings, spaSections } from '../../../../src/cms/content.ts'
import { CONTENT_COPY_AR } from '../../../../src/cms/copy-ar.ts'
import { assertPageCopyCompliant, contentPageData } from '../../../../src/cms/page-data.ts'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { pageGraph } from '../../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../../src/seo/structured-data.tsx'
import { SpaBody } from '../../../_content/pages.tsx'
import { NAP_COPY_AR } from '../../../_routes/nap-copy.ts'
import { RouteNav } from '../../../_routes/route-nav.tsx'

export const metadata: Metadata = {
  title: 'السبا — BE RELAX Massage Center and Spa',
  description: 'أين يقع السبا، وكيف تدخل، وأين توقف سيارتك، ومتى تُفتح الأبواب.',
  ...routeMetadata('spa', 'ar'),
}

export default async function ArabicSpaPage() {
  const { facts, licenceClass, policy } = await contentPageData()
  const copy = CONTENT_COPY_AR
  assertPageCopyCompliant(
    'spa',
    renderedStrings({
      title: copy.spa.title,
      lede: copy.spa.lede,
      sections: spaSections(copy, { facts, locale: 'ar' }),
    }),
    policy,
  )
  const graph = pageGraph({
    id: 'spa',
    locale: 'ar',
    facts,
    licenceClass,
    breadcrumb: { home: copy.home, page: copy.spa.title },
    includeCatalogue: false,
  })
  return (
    <>
      <StructuredData graph={graph} />
      <RouteNav id="spa" locale="ar" />
      <SpaBody facts={facts} copy={copy} locale="ar" napCopy={NAP_COPY_AR} />
    </>
  )
}
