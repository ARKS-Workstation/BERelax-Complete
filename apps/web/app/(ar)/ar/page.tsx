/**
 * The Arabic home route.
 *
 * A separate route rather than a runtime toggle, because the language is part of the URL a crawler indexes
 * and a customer shares. `lang` and `dir` are set by the `(ar)` root layout on `<html>`, not here on a
 * wrapper — `theme/arabic.css` inherits the whole recalibration from the document element, and a wrapper
 * leaves `body` Latin.
 *
 * It is the same registry entry as `/`, which is what makes the two documents' `hreflang` sets identical:
 * `routeMetadata('home', 'ar')` and `routeMetadata('home', 'en')` differ only in which URL is canonical. It is
 * also the same body component, for the reason `_treatments/pages.tsx` gives: two copies of this page would
 * be two places the section order, the anchor ids and the card shapes could drift, and the RTL half of every
 * assertion would then be testing a different component from the LTR half.
 *
 * The locality is still not transliterated here. W-SITE-02 found the Arabic street and district hard-coded in
 * this file and in the `(ar)` layout — a second NAP the grep gate could not see, because its patterns are
 * Latin script — and removed both. `premises` holds one spelling of the address and it is the English one, so
 * this document renders that row through the same NAP block the English one does.
 */
import type { Metadata } from 'next'
import { navLabels } from '../../../src/cms/content.ts'
import { CONTENT_COPY_AR } from '../../../src/cms/copy-ar.ts'
import { assertPageCopyCompliant } from '../../../src/cms/page-data.ts'
import {
  bookActionFor,
  homeRenderedStrings,
  NO_THERAPIST_ROUTE,
  reviewSection,
  therapistCardsFor,
  treatmentCardsFor,
} from '../../../src/home/content.ts'
import { HOME_COPY_AR } from '../../../src/home/copy-ar.ts'
import { homePageData } from '../../../src/home/read.ts'
import { localisedPath } from '../../../src/i18n/locales.ts'
import { heroDemoMedia } from '../../../src/media/hero-demo-asset.ts'
import { homeGalleryImages } from '../../../src/media/home-gallery.ts'
import { routeMetadata } from '../../../src/routes/alternates.ts'
import { pageGraph } from '../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../src/seo/structured-data.tsx'
import { MENU_COPY_AR } from '../../../src/treatments/copy-ar.ts'
import { HomeBody } from '../../_home/home-page.tsx'
import { NAP_COPY_AR } from '../../_routes/nap-copy.ts'
import { RouteNav } from '../../_routes/route-nav.tsx'

export const metadata: Metadata = routeMetadata('home', 'ar')

export default async function ArabicHomePage() {
  const { facts, licenceClass, policy, therapists, reviews } = await homePageData()
  const copy = HOME_COPY_AR
  assertPageCopyCompliant('home', homeRenderedStrings(facts, copy, therapists.length), policy)
  const graph = pageGraph({
    id: 'home',
    locale: 'ar',
    facts,
    licenceClass,
    breadcrumb: { home: copy.home, page: copy.home },
    includeCatalogue: false,
  })
  const hero = heroDemoMedia()
  return (
    <>
      <StructuredData graph={graph} />
      <RouteNav id="home" locale="ar" />
      <HomeBody
        facts={facts}
        copy={copy}
        napCopy={NAP_COPY_AR}
        locale="ar"
        nav={{ label: CONTENT_COPY_AR.labels.nav, labels: navLabels(CONTENT_COPY_AR) }}
        hero={{ poster: hero.poster, video: hero.video }}
        gallery={homeGalleryImages()}
        treatments={treatmentCardsFor(facts, MENU_COPY_AR.durationLabel, (slug) =>
          localisedPath(`/treatments/${slug}`, 'ar'),
        )}
        therapists={therapistCardsFor(therapists, NO_THERAPIST_ROUTE, (skills) =>
          skills.length === 0
            ? undefined
            : skills
                .map((skill) => copy.labels.skills[skill] ?? skill)
                .join(copy.labels.skillSeparator),
        )}
        reviews={reviewSection(reviews).cards}
        book={bookActionFor(facts)}
      />
    </>
  )
}
