/**
 * `/ar/contact` — the desk, in Arabic. The same registry entry as `/contact`; see `/ar/spa/page.tsx`.
 */
import type { Metadata } from 'next'
import { contactSections, renderedStrings } from '../../../../src/cms/content.ts'
import { CONTENT_COPY_AR } from '../../../../src/cms/copy-ar.ts'
import { assertPageCopyCompliant, contentPageData } from '../../../../src/cms/page-data.ts'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { pageGraph } from '../../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../../src/seo/structured-data.tsx'
import { ContactBody } from '../../../_content/pages.tsx'
import { NAP_COPY_AR } from '../../../_routes/nap-copy.ts'
import { RouteNav } from '../../../_routes/route-nav.tsx'

export const metadata: Metadata = {
  title: 'اتصل بنا — BE RELAX Massage Center and Spa',
  description: 'أرقام الهاتف والعنوان والأوقات التي يوجد فيها من يجيب في المكتب.',
  ...routeMetadata('contact', 'ar'),
}

export default async function ArabicContactPage() {
  const { facts, licenceClass, policy } = await contentPageData()
  const copy = CONTENT_COPY_AR
  assertPageCopyCompliant(
    'contact',
    renderedStrings({
      title: copy.contact.title,
      lede: copy.contact.lede,
      sections: contactSections(copy, { facts, locale: 'ar' }),
    }),
    policy,
  )
  const graph = pageGraph({
    id: 'contact',
    locale: 'ar',
    facts,
    licenceClass,
    breadcrumb: { home: copy.home, page: copy.contact.title },
    includeCatalogue: false,
  })
  return (
    <>
      <StructuredData graph={graph} />
      <RouteNav id="contact" locale="ar" />
      <ContactBody facts={facts} copy={copy} locale="ar" napCopy={NAP_COPY_AR} />
    </>
  )
}
