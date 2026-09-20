/**
 * `/ar/about` — in Arabic. The same registry entry as `/about`; see `/ar/spa/page.tsx`.
 *
 * The `pages` document it would render is the same row as the English page's: the content model has no locale
 * and Payload localisation is not enabled, so an editor writes one `about` document and both documents show
 * it. That is W-SITE-05's decision about the treatment name applied to a body of prose — a translation
 * invented here would be a second, unlinted version of the same page, disagreeing with the one beside it —
 * and it is recorded in the manifest as deferred to W-SITE-10, which owns the Arabic narrative. Today the
 * collection is empty, so both documents render the derived answers in their own language.
 */
import type { Metadata } from 'next'
import { aboutSections, renderedStrings } from '../../../../src/cms/content.ts'
import { CONTENT_COPY_AR } from '../../../../src/cms/copy-ar.ts'
import { assertPageCopyCompliant, contentPageData } from '../../../../src/cms/page-data.ts'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { pageGraph } from '../../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../../src/seo/structured-data.tsx'
import { AboutBody } from '../../../_content/pages.tsx'
import { RouteNav } from '../../../_routes/route-nav.tsx'

export const metadata: Metadata = {
  title: 'عن المكان — BE RELAX Massage Center and Spa',
  description: 'ما هذا المكان، وأين يقع، وكيف تميزه عن سبا المطار ذي الاسم المشابه.',
  ...routeMetadata('about', 'ar'),
}

export default async function ArabicAboutPage() {
  const { facts, licenceClass, policy, pages } = await contentPageData()
  const copy = CONTENT_COPY_AR
  assertPageCopyCompliant(
    'about',
    renderedStrings({
      title: copy.about.title,
      lede: copy.about.lede,
      sections: aboutSections(copy, { facts, locale: 'ar' }),
    }),
    policy,
  )
  const graph = pageGraph({
    id: 'about',
    locale: 'ar',
    facts,
    licenceClass,
    breadcrumb: { home: copy.home, page: copy.about.title },
    includeCatalogue: false,
  })
  return (
    <>
      <StructuredData graph={graph} />
      <RouteNav id="about" locale="ar" />
      <AboutBody facts={facts} copy={copy} locale="ar" pages={pages} />
    </>
  )
}
