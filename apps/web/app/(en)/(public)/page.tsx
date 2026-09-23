/**
 * The public home route, in English.
 *
 * A server component rendering complete HTML, and since W-SITE-04 an **ISR** route rather than a static one —
 * which is what docs/09 §1 lists it as, and what unblocked the two things the previous version of this file
 * recorded as deferred:
 *
 *   - **the locality beside the trading name.** docs/09 §"The brand collision" wants the full name paired
 *     with the district on this page, and a `rendering: 'static'` route is evaluated during `next build`,
 *     which has no database by design. A build-time read would bake an address nothing could then correct —
 *     a hard-coded address with extra steps. Under ISR a correction reaches the page by revalidation, and
 *     `src/revalidate/content.ts` lists `home` under a premises change.
 *   - **the JSON-LD.** `apps/web/src/seo/structured-data.itest.ts` asserted, in so many words, that this
 *     route carried no graph *because* it was static and named this unit as the one that would put one on
 *     it. It does now: `LocalBusiness`/`DaySpa`, `Organization` and `WebSite`, from the premises row.
 *
 * The cost is the one W-SITE-05 already paid and CI already handles: `next build` needs a migrated and
 * seeded database, and `.github/workflows/ci.yml` applies the migrations and seeds before the build step.
 *
 * `includeCatalogue` is **false**, which is the same reading `/spa`, `/contact` and `/about` take. This
 * page's subject is the business; the eight treatments each publish their own `Service` and four `Offer`s on
 * their own page, and republishing all forty nodes here would be the reconciliation problem that flag exists
 * to prevent — on the one document every crawler fetches first.
 */
import type { Metadata } from 'next'
import { navLabels } from '../../../src/cms/content.ts'
import { CONTENT_COPY_EN } from '../../../src/cms/copy-en.ts'
import { assertPageCopyCompliant } from '../../../src/cms/page-data.ts'
import {
  bookActionFor,
  homeRenderedStrings,
  NO_THERAPIST_ROUTE,
  reviewSection,
  therapistCardsFor,
  treatmentCardsFor,
} from '../../../src/home/content.ts'
import { HOME_COPY_EN } from '../../../src/home/copy-en.ts'
import { homePageData } from '../../../src/home/read.ts'
import { localisedPath } from '../../../src/i18n/locales.ts'
import { heroDemoMedia } from '../../../src/media/hero-demo-asset.ts'
import { homeGalleryImages } from '../../../src/media/home-gallery.ts'
import { routeMetadata } from '../../../src/routes/alternates.ts'
import { pageGraph } from '../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../src/seo/structured-data.tsx'
import { MENU_COPY_EN } from '../../../src/treatments/copy-en.ts'
import { HomeBody } from '../../_home/home-page.tsx'
import { NAP_COPY_EN } from '../../_routes/nap-copy.ts'
import { RouteNav } from '../../_routes/route-nav.tsx'

export const metadata: Metadata = routeMetadata('home', 'en')

export default async function HomePage() {
  const { facts, licenceClass, policy, therapists, reviews } = await homePageData()
  const copy = HOME_COPY_EN
  // Every string this page is about to render, through the banned-claims lint — the same call the five CMS
  // routes make, and for the same reason: this lints the *rendered* copy, including every value interpolated
  // out of the premises row and the catalogue, rather than a template with holes in it.
  assertPageCopyCompliant('home', homeRenderedStrings(facts, copy, therapists.length), policy)
  const graph = pageGraph({
    id: 'home',
    locale: 'en',
    facts,
    licenceClass,
    breadcrumb: { home: copy.home, page: copy.home },
    includeCatalogue: false,
  })
  const hero = heroDemoMedia()
  return (
    <>
      <StructuredData graph={graph} />
      <RouteNav id="home" locale="en" />
      <HomeBody
        facts={facts}
        copy={copy}
        napCopy={NAP_COPY_EN}
        locale="en"
        nav={{ label: CONTENT_COPY_EN.labels.nav, labels: navLabels(CONTENT_COPY_EN) }}
        hero={{ poster: hero.poster, video: hero.video }}
        gallery={homeGalleryImages()}
        treatments={treatmentCardsFor(facts, MENU_COPY_EN.durationLabel, (slug) =>
          localisedPath(`/treatments/${slug}`, 'en'),
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
