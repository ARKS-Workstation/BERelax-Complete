/**
 * `/ar/faq` — in Arabic. The same registry entry as `/faq`; see `/ar/spa/page.tsx`.
 *
 * The rows are the same rows: `faq_entries` has one `question` column and one `answer` column, so an entry an
 * editor writes appears on both documents in the language it was written in, inside Arabic chrome. That is the
 * same decision W-SITE-05 took about the treatment name and recorded in its own NOTE, and for the same
 * reason — a translation invented here would be a second, unlinted answer to the same question, disagreeing
 * with the `FAQPage` block beside it. Deferred to W-SITE-10, which owns the Arabic narrative.
 */
import type { Metadata } from 'next'
import { faqSections, publishableFaqEntries, renderedStrings } from '../../../../src/cms/content.ts'
import { CONTENT_COPY_AR } from '../../../../src/cms/copy-ar.ts'
import { assertPageCopyCompliant, contentPageData } from '../../../../src/cms/page-data.ts'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { pageGraph } from '../../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../../src/seo/structured-data.tsx'
import { FaqBody } from '../../../_content/pages.tsx'
import { RouteNav } from '../../../_routes/route-nav.tsx'

export const metadata: Metadata = {
  title: 'أسئلة وأجوبة — BE RELAX Massage Center and Spa',
  description: 'الأسئلة التي تُطرح على المكتب أكثر من غيرها، والأجوبة التي يقدمها.',
  ...routeMetadata('faq', 'ar'),
}

export default async function ArabicFaqPage() {
  const { facts, licenceClass, policy, faq } = await contentPageData()
  const copy = CONTENT_COPY_AR
  const entries = publishableFaqEntries(faq)
  assertPageCopyCompliant(
    'faq',
    renderedStrings({
      title: copy.faq.title,
      lede: copy.faq.lede,
      sections: faqSections(entries),
      extra: [copy.faq.empty],
    }),
    policy,
  )
  const graph = pageGraph({
    id: 'faq',
    locale: 'ar',
    facts,
    licenceClass,
    breadcrumb: { home: copy.home, page: copy.faq.title },
    includeCatalogue: false,
    faq: entries,
  })
  return (
    <>
      <StructuredData graph={graph} />
      <RouteNav id="faq" locale="ar" />
      <FaqBody copy={copy} locale="ar" entries={entries} />
    </>
  )
}
