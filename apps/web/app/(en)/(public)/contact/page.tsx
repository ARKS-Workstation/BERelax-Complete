/**
 * `/contact` — the desk, in English.
 *
 * The second of docs/09 §4's three visible NAP surfaces, and the other half of W-SITE-02's deferral. Every
 * number, line of the address and opening time comes from the `premises` row; the WhatsApp number does not
 * appear at all, because there is no confirmed one (Y1-nap) and `factsSchema` models the channel as a union
 * carrying no digits while it is unconfirmed.
 */
import type { Metadata } from 'next'
import { contactSections, renderedStrings } from '../../../../src/cms/content.ts'
import { CONTENT_COPY_EN } from '../../../../src/cms/copy-en.ts'
import { assertPageCopyCompliant, contentPageData } from '../../../../src/cms/page-data.ts'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { pageGraph } from '../../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../../src/seo/structured-data.tsx'
import { ContactBody } from '../../../_content/pages.tsx'
import { NAP_COPY_EN } from '../../../_routes/nap-copy.ts'
import { RouteNav } from '../../../_routes/route-nav.tsx'

export const metadata: Metadata = {
  title: 'Contact — BE RELAX Massage Center and Spa',
  description: 'The telephone numbers, the address, and the hours somebody is at the desk.',
  ...routeMetadata('contact', 'en'),
}

export default async function ContactPage() {
  const { facts, licenceClass, policy } = await contentPageData()
  const copy = CONTENT_COPY_EN
  assertPageCopyCompliant(
    'contact',
    renderedStrings({
      title: copy.contact.title,
      lede: copy.contact.lede,
      sections: contactSections(copy, { facts, locale: 'en' }),
    }),
    policy,
  )
  const graph = pageGraph({
    id: 'contact',
    locale: 'en',
    facts,
    licenceClass,
    breadcrumb: { home: copy.home, page: copy.contact.title },
    includeCatalogue: false,
  })
  return (
    <>
      <StructuredData graph={graph} />
      <RouteNav id="contact" locale="en" />
      <ContactBody facts={facts} copy={copy} locale="en" napCopy={NAP_COPY_EN} />
    </>
  )
}
