/**
 * `/about` — in English.
 *
 * The editorial body is a `pages` document with the slug `about`, rendered above the derived answers when an
 * editor has published one; the collection holds no rows today, so what the page says is what the business's
 * own records say. docs/09 §1 lists `/about` among "the pages an acquirer requires", and the one question it
 * has to answer that no other page does is the entity question: this is not the airport spa of a similar
 * name (docs/09 §"The brand collision").
 */
import type { Metadata } from 'next'
import { aboutSections, renderedStrings } from '../../../../src/cms/content.ts'
import { CONTENT_COPY_EN } from '../../../../src/cms/copy-en.ts'
import { assertPageCopyCompliant, contentPageData } from '../../../../src/cms/page-data.ts'
import { routeMetadata } from '../../../../src/routes/alternates.ts'
import { pageGraph } from '../../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../../src/seo/structured-data.tsx'
import { AboutBody } from '../../../_content/pages.tsx'
import { RouteNav } from '../../../_routes/route-nav.tsx'

export const metadata: Metadata = {
  title: 'About — BE RELAX Massage Center and Spa',
  description: 'What this place is, where it is, and how to tell it apart from the airport spa.',
  ...routeMetadata('about', 'en'),
}

export default async function AboutPage() {
  const { facts, licenceClass, policy, pages } = await contentPageData()
  const copy = CONTENT_COPY_EN
  assertPageCopyCompliant(
    'about',
    renderedStrings({
      title: copy.about.title,
      lede: copy.about.lede,
      sections: aboutSections(copy, { facts, locale: 'en' }),
    }),
    policy,
  )
  const graph = pageGraph({
    id: 'about',
    locale: 'en',
    facts,
    licenceClass,
    breadcrumb: { home: copy.home, page: copy.about.title },
    includeCatalogue: false,
  })
  return (
    <>
      <StructuredData graph={graph} />
      <RouteNav id="about" locale="en" />
      <AboutBody facts={facts} copy={copy} locale="en" pages={pages} />
    </>
  )
}
