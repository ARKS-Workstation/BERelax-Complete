/**
 * The home page's body, rendered once and served in two locales.
 *
 * The prototype is **one document with anchors** and docs/09 §"Routes versus anchors" is the argument for
 * keeping that: `#services` cannot rank, because an anchor is not a document, but the anchored single-page
 * feel is good UX and is the approved design. So the shape is inherited and every card links out — the
 * anchors serve navigation on this page, and the routes earn the rankings.
 *
 * The folder is `_home`, with the underscore, for the reason `_treatments` and `_content` are: Next excludes
 * an underscore-prefixed folder from routing, so this contributes no URL and the registry's bijection with
 * the filesystem is unaffected (`src/routes/discover.ts` skips them for the same reason).
 *
 * ## What is above the fold, and why so little is
 *
 * The hero, the H1 and the sentence under it. Nothing else, and nothing that animates. Two of this unit's
 * criteria are about first paint — the LCP element must be the hero `<img>`, and no element above the fold
 * may have a running animation or a computed opacity below 1 — and W-SYS-07 recorded what a condensing
 * header does to the second of them: `animation-timeline: scroll()` on an above-the-fold element is a
 * *running* animation at scroll zero, so a page carrying one can never satisfy the ban. This page therefore
 * has no condensing header, and no reveal above the fold either.
 *
 * ## Why the sticky bar dials
 *
 * `/book` is the booking flow and it is another unit's route. A link to it from here would be an internal
 * link that is not a 200, which is the first rule the link-graph invariant refuses
 * (`apps/web/src/content.itest.ts`). `bookActionFor` builds a `tel:` from the premises row instead, which is
 * not a stand-in for the flow: docs/13 §6 records that booking on the live site is WhatsApp and telephone
 * only, so this is the channel the business actually takes bookings on today.
 */
import type { Facts } from '@berelax/shared'
import { DesignSystemStyles, Grid, GridCell, Measure, Section } from '@berelax/ui/layout'
import {
  BookBarSpacer,
  NapBlock,
  type NapBlockCopy,
  StickyBookBar,
  TherapistCard,
} from '@berelax/ui/patterns'
import type { ReactElement } from 'react'
import { HeroMedia } from '../../src/components/media/hero-media.tsx'
import { SlotPicture } from '../../src/components/media/slot-picture.tsx'
import {
  type BookAction,
  brandAndLocality,
  businessNames,
  HOME_SECTIONS,
  type HomeCopy,
  type HomeSectionId,
  homeAnchor,
  menuSize,
  type ReviewCard,
  type TherapistCard as TherapistCardData,
  type TreatmentCard,
} from '../../src/home/content.ts'
import type { Locale } from '../../src/i18n/locales.ts'
import type { GalleryImage } from '../../src/media/home-gallery.ts'
import type { NavRouteId } from '../../src/routes/nav.ts'
import { SiteNav } from '../_routes/site-nav.tsx'

/**
 * The card grids and the one band the hero sits above.
 *
 * `auto-fill` with a `minmax` floor rather than a breakpoint: the number of treatments and the number of
 * therapists are both counts of rows, so the number of columns is a question about how much room there is
 * and not about how wide the window is. It also means nothing here needs a media query, which is what keeps
 * this page's CSS the same shape as the container-query components it renders.
 */
const HOME_CSS = `
.be-home__cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
  gap: var(--space-8);
  list-style: none;
  margin: 0;
  padding: 0;
}

.be-home__cards > li { display: flex; flex-direction: column; gap: var(--space-3); min-inline-size: 0; }

.be-home__cards blockquote { margin: 0; }

/* The anchor target itself must not draw a ring for a click that merely landed inside it: the ring is for a
   reader who followed an in-page link, which is what :focus-visible means. */
.be-home__section:focus { outline: none; }
.be-home__section:focus-visible { outline: 2px solid var(--color-focus); outline-offset: -2px; }
`

/** The hero's two media references. Built by the route, which is where a filesystem read belongs. */
export interface HomeHeroMedia {
  readonly poster: { readonly mediaId: string; readonly contentHash: string; readonly slot: string }
  readonly video: { readonly mediaId: string; readonly contentHash: string }
}

export interface HomeBodyProps {
  readonly facts: Facts
  readonly copy: HomeCopy
  readonly napCopy: NapBlockCopy
  readonly locale: Locale
  /** The site navigation's accessible name and one label per page, from the CMS copy of this locale. */
  readonly nav: {
    readonly label: string
    readonly labels: Readonly<Record<NavRouteId, string>>
  }
  readonly hero: HomeHeroMedia
  readonly gallery: readonly GalleryImage[]
  readonly treatments: readonly TreatmentCard[]
  readonly therapists: readonly TherapistCardData[]
  readonly reviews: readonly ReviewCard[]
  readonly book: BookAction | null
}

/**
 * One band, with its anchor.
 *
 * `id` and `tabIndex={-1}` together, never one without the other: the id is what the fragment resolves to
 * and the `tabindex` is what lets the reader's *focus* follow it rather than only the scroll position. A
 * section with the first and not the second is a link that moves the page and leaves a keyboard user where
 * they were, which is a WCAG 2.4.1 failure rather than a missing nicety.
 */
function AnchoredSection({
  id,
  copy,
  surface,
  children,
}: {
  readonly id: HomeSectionId
  readonly copy: HomeCopy
  readonly surface?: 'ground' | 'sand'
  readonly children: ReactElement
}) {
  const section = copy.sections[id]
  return (
    // `surface` is spread rather than passed: `exactOptionalPropertyTypes` is on, so an explicit `undefined`
    // is not the same thing as an absent prop and does not satisfy an optional one.
    <Section
      id={id}
      tabIndex={-1}
      {...(surface === undefined ? {} : { surface })}
      className="be-home__section"
    >
      <Grid>
        <GridCell span="wide">
          <Measure cap="h2" as="h2" className="text-xl be-section__heading">
            {section.heading}
          </Measure>
          <Measure cap="lede">{section.lede}</Measure>
        </GridCell>
        {children}
      </Grid>
    </Section>
  )
}

export function HomeBody({
  facts,
  copy,
  napCopy,
  locale,
  nav,
  hero,
  gallery,
  treatments,
  therapists,
  reviews,
  book,
}: HomeBodyProps): ReactElement {
  const size = menuSize(facts)
  return (
    <main>
      {/*
        The design system's stylesheet, and then this page's three rules.
        Both are `<style>` elements React hoists and deduplicates by `href`. Leaving `DesignSystemStyles` off
        was this unit's own first defect and it was not subtle in its effects — the sticky bar computed
        `position: static`, so the bar that exists to sit in the thumb zone sat at the end of the document —
        but it was silent in the markup: every class name was there and every assertion about text content
        passed. `home.itest.ts` reads computed styles for exactly that reason.
      */}
      <DesignSystemStyles />
      <style href="berelax-home" precedence="default">
        {HOME_CSS}
      </style>
      {/*
        The hero first and outside any band. A hero is full-bleed: `Section` would put the page gutter
        around it, and the LCP element would then be narrower than the viewport on the device the whole
        budget in docs/08 §8 is written for.
      */}
      <HeroMedia
        poster={hero.poster}
        video={hero.video}
        copy={{
          alt: copy.hero.alt,
          control: { play: copy.hero.play, pause: copy.hero.pause },
        }}
      />

      <Section as="header">
        <Grid>
          <GridCell span="wide">
            <p className="text-eyebrow text-ink-2 uppercase">{copy.eyebrow}</p>
            <Measure cap="h1" as="h1" className="text-3xl">
              {copy.heading}
            </Measure>
            <Measure cap="lede" className="text-lg text-ink-2">
              {copy.lede}
            </Measure>
          </GridCell>
        </Grid>
      </Section>

      {/*
        The anchors, from `HOME_SECTIONS` rather than from six literals. `/#services` is a URL a reader may
        have bookmarked and a Google Business Profile link may point at, so the ids are part of the contract
        — and a page that spelled them in its JSX could drop one, reorder two or rename a third without
        failing anything.
      */}
      <Section as="div">
        <Grid>
          <GridCell span="wide">
            <nav aria-label={copy.onThisPage} className="be-actions" data-home-nav="">
              {HOME_SECTIONS.map((id) => (
                <a
                  key={id}
                  className="be-action be-action--quiet"
                  href={homeAnchor(id)}
                  data-home-link={id}
                >
                  {copy.sections[id].heading}
                </a>
              ))}
            </nav>
          </GridCell>
        </Grid>
      </Section>

      <AnchoredSection id="about" copy={copy} surface="sand">
        <GridCell>
          {/*
            The full name paired with the locality, from the rows. docs/09 §"The brand collision": an
            international airport-spa chain trades under a similar short name and has an outlet in this city,
            so the bare brand is unwinnable and every citation has to carry both. This is the sentence
            `app/(en)/(public)/page.tsx` deferred to this unit while the route was static and had no database
            to read it from.
          */}
          <p data-home-fact="brand-and-locality">{brandAndLocality(facts, copy.labels.and)}</p>
          <ul data-home-fact="names">
            {businessNames(facts).map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
          <p data-home-fact="menu-size">{copy.labels.menuSize(size.services, size.pricePoints)}</p>
          <p data-home-fact="roster-size">{copy.labels.rosterSize(therapists.length)}</p>
        </GridCell>
      </AnchoredSection>

      <AnchoredSection id="services" copy={copy}>
        <GridCell span="wide" as="ul" className="be-home__cards">
          {treatments.map((card) => (
            <li key={card.slug} data-treatment-card={card.slug}>
              {/*
                Every card is a link to a real indexable route, which is the criterion and the point of
                docs/09 §"Routes versus anchors". No price: the price of one of these is four figures, and a
                "from" price here would be a fifth rendering of a row whose only purpose is to be compared
                with the four on the page it links to.
              */}
              <a href={card.href}>{copy.labels.seeTreatment(card.name)}</a>
              <span className="text-sm text-ink-2">
                {card.durations.join(copy.labels.durationSeparator)}
              </span>
            </li>
          ))}
        </GridCell>
      </AnchoredSection>

      <AnchoredSection id="team" copy={copy} surface="sand">
        <GridCell span="wide" as="ul" className="be-home__cards">
          {therapists.map((card) => (
            <li key={card.reference}>
              {/*
                `href` and `portrait` are both absent for every one of these today, and each absence is a
                guard rather than a gap: ADR 0020 needs a display name AND a recorded photography consent
                before a therapist has a page, and no derivative of any portrait has been built. The card
                renders the reference, the skill and the reserved box.
              */}
              <TherapistCard
                reference={card.reference}
                unnamedLabel={copy.labels.unnamedTherapist}
                {...(card.displayName === undefined ? {} : { displayName: card.displayName })}
                {...(card.href === undefined ? {} : { href: card.href })}
                {...(card.qualifications === undefined
                  ? {}
                  : { qualifications: card.qualifications })}
              />
            </li>
          ))}
        </GridCell>
      </AnchoredSection>

      <AnchoredSection id="gallery" copy={copy}>
        <GridCell span="wide" as="ul" className="be-home__cards">
          {gallery.map((image, index) => (
            <li key={image.source} data-gallery-image={image.source}>
              {/*
                The production `<picture>`, art-directed from the same builder the admin's breakpoint preview
                renders (`slot-picture.tsx` records why there is only one). Not `priority`: exactly one
                element on a page may be the LCP candidate and it is the hero, so these are lazy and
                `decoding="async"`, which is what keeps them out of the requests-before-LCP count.
              */}
              <SlotPicture media={image.media} alt={copy.labels.galleryAlt(index + 1)} />
            </li>
          ))}
        </GridCell>
      </AnchoredSection>

      <AnchoredSection id="reviews" copy={copy} surface="sand">
        <GridCell span="wide">
          {/*
            `data-reviews` is the count the page rendered from, so a test can assert the rendered
            testimonials against the rows without inferring the number from the markup it is judging.
          */}
          <div data-reviews={String(reviews.length)}>
            {reviews.length === 0 ? (
              <div data-home-fact="no-reviews">
                <Measure cap="body">{copy.labels.noReviews}</Measure>
              </div>
            ) : (
              <ul className="be-home__cards">
                {reviews.map((review) => (
                  <li key={review.id} data-review-card={review.googleReviewId}>
                    {/*
                      A quotation from a review record, attributed to the name Google publishes. docs/09
                      §"Schema types": surface genuine reviews, and do not mark up your own testimonials as
                      review snippets — so there is no `AggregateRating` on this page and no rating markup of
                      any kind. `reviewSection` in `src/home/content.ts` says why that is a decision rather
                      than a gap.
                    */}
                    <blockquote>{review.quote}</blockquote>
                    <p className="text-sm text-ink-2">{copy.labels.reviewBy(review.attribution)}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </GridCell>
      </AnchoredSection>

      <AnchoredSection id="contact" copy={copy}>
        <GridCell span="wide">
          {/*
            The NAP block takes the `/api/facts` payload rather than a shape of its own, which is what makes
            "the footer and the fact sheet agree" true by construction (W-SITE-02). This is the first ISR
            route that renders it on the home page, and `src/revalidate/content.ts` now lists `home` under a
            premises change for exactly that reason.
          */}
          <NapBlock copy={napCopy} facts={facts} />
        </GridCell>
      </AnchoredSection>

      {/*
        The site navigation. W-SITE-07 left a note saying a real header should replace it; this page does not
        add one, so the list stays — and the link-graph invariant is what would say so if it ever carried
        fewer links than the registry declares.
      */}
      <SiteNav current="home" locale={locale} label={nav.label} labels={nav.labels} />

      {/* Reserves the bar's height, so a fixed bar covers nothing at the end of the document. */}
      <BookBarSpacer />
      {book === null ? null : (
        <StickyBookBar
          ariaLabel={copy.labels.bookBar}
          label={book.telephone}
          action={{
            href: book.href,
            text: copy.labels.bookBar,
            ariaLabel: copy.labels.bookBarLabel(book.telephone),
          }}
        />
      )}
    </main>
  )
}
