/**
 * The bodies of the five CMS-and-premises routes, rendered once and served in two locales.
 *
 * Ten route files and five components, exactly as `app/_treatments/pages.tsx` is six and three, and for the
 * same reason: the structure of a page is one thing and the language of a page is another. Two copies of
 * `/spa` would be two places the address, the trail and the heading shape could drift, and the RTL half of
 * every layout assertion would be testing a different component from the LTR half.
 *
 * ## What these components may and may not do
 *
 * They render. They do not read: the fact sheet, the FAQ rows, the posts and the disclaimer all arrive as
 * props, already read once by `contentPageData()` and already linted. They contain no address, no telephone
 * number, no opening time and no price — `packages/db/src/seed/premises.test.ts` greps every file under
 * `apps/` and `packages/` for the street and the four numbers and fails on a match, so the `/spa` acceptance
 * criterion ("from the premises row only, inheriting the W-SITE-02 grep gate with zero literals") is a
 * property of this file rather than a claim about it: there is nowhere here for a literal to hide.
 *
 * Every `<h2>` on these pages comes from `QuestionSections` in `app/_treatments/sections.tsx` — the single
 * `<h2>`-emitting component W-SITE-05 built, whose JSX puts the answering `<p>` next to the heading with
 * nothing between them and nothing optional about it. Importing it out of `_treatments/` is deliberate: a
 * second component with the same job is how "immediately followed by a `<p>`" stops being guaranteed.
 */

import type { FaqEntry } from '@berelax/core'
import type { Facts } from '@berelax/shared'
import { DesignSystemStyles, Grid, GridCell, Measure, Section } from '@berelax/ui/layout'
import { NapBlock, type NapBlockCopy } from '@berelax/ui/patterns'
import {
  aboutSections,
  anyHealthAdjacent,
  type ContentCopy,
  contactSections,
  editorialPageFor,
  faqSections,
  journalSections,
  navLabels,
  spaSections,
} from '../../src/cms/content.ts'
import type { EditorialPage, JournalPost } from '../../src/cms/read.ts'
import { type Locale, localisedPath } from '../../src/i18n/locales.ts'
import type { NavRouteId } from '../../src/routes/nav.ts'
import { Breadcrumb } from '../_routes/breadcrumb.tsx'
import { SiteNav } from '../_routes/site-nav.tsx'
import { QuestionSections } from '../_treatments/sections.tsx'

/*
 * The paths these pages link to each other with.
 *
 * Spelled from the registry's own paths through `localisedPath`, which is the one place a locale becomes a
 * URL — the same decision `app/_treatments/pages.tsx` records, and for the same reason: these are components,
 * a registry lookup per render is a lookup per render, and `registry.test.ts`'s bijection is what keeps the
 * spelling honest.
 */
const menuPath = (locale: Locale): string => localisedPath('/treatments', locale)
const pricingPath = (locale: Locale): string => localisedPath('/pricing', locale)
const contactPath = (locale: Locale): string => localisedPath('/contact', locale)
const faqPath = (locale: Locale): string => localisedPath('/faq', locale)

export interface ContentPageProps {
  readonly facts: Facts
  readonly copy: ContentCopy
  readonly locale: Locale
}

/** The chrome every one of these pages carries: the trail, the heading, the lede and the nav. */
function PageHeader({
  copy,
  locale,
  current,
  title,
  lede,
}: {
  readonly copy: ContentCopy
  readonly locale: Locale
  readonly current: NavRouteId
  readonly title: string
  readonly lede: string
}) {
  return (
    <Section as="header">
      <Grid>
        <GridCell span="wide">
          <Breadcrumb
            locale={locale}
            label={title}
            trail={[{ label: copy.home, href: localisedPath('/', locale) }]}
            currentLabel={title}
          />
          <Measure cap="h1" as="h1" className="text-3xl">
            {title}
          </Measure>
          <Measure cap="lede">{lede}</Measure>
          <SiteNav
            current={current}
            locale={locale}
            label={copy.labels.nav}
            labels={navLabels(copy)}
          />
        </GridCell>
      </Grid>
    </Section>
  )
}

/** The map and directions links, from the row's own URLs. Never a hand-built query string. */
function PlaceLinks({ facts, copy }: { readonly facts: Facts; readonly copy: ContentCopy }) {
  return (
    <p className="be-actions">
      <a className="be-action be-action--quiet" href={facts.geo.mapUrl}>
        {copy.labels.map}
      </a>
      <a className="be-action be-action--quiet" href={facts.geo.directionsUrl}>
        {copy.labels.directions}
      </a>
    </p>
  )
}

export interface SpaBodyProps extends ContentPageProps {
  readonly napCopy: NapBlockCopy
}

/**
 * `/spa` — the place: where it is, how to get in, parking, transport, the rooms and the hours.
 *
 * Every one of those comes out of the premises row or says, in the answer itself, that the row holds nothing
 * for it. Two do: there is no `public_transport_notes` or `landmarks` column at all, although docs/09 §4 lists
 * both among the fields `premises` holds, and the room inventory on record is the provisional five-room stub
 * (Y8-rooms). Publishing either would be the invented value this whole build refuses.
 */
export function SpaBody({ facts, copy, locale, napCopy }: SpaBodyProps) {
  return (
    <main>
      <DesignSystemStyles />
      <PageHeader
        copy={copy}
        locale={locale}
        current="spa"
        title={copy.spa.title}
        lede={copy.spa.lede}
      />

      <Section>
        <Grid>
          <GridCell>
            <Measure cap="body" as="div">
              <QuestionSections sections={spaSections(copy, { facts, locale })} />
            </Measure>
            <PlaceLinks facts={facts} copy={copy} />
          </GridCell>
        </Grid>
      </Section>

      <Section>
        <Grid>
          <GridCell span="wide">
            {/* The same block the footer and the admin rail render, from the same payload `/api/facts`
                serves. docs/09 §4 names `/spa` as one of its three visible surfaces. */}
            <NapBlock copy={napCopy} facts={facts} />
          </GridCell>
        </Grid>
      </Section>

      <Section>
        <Grid>
          <GridCell>
            <p className="be-actions">
              <a className="be-action be-action--quiet" href={menuPath(locale)}>
                {copy.labels.menu}
              </a>
              <a className="be-action be-action--quiet" href={contactPath(locale)}>
                {copy.labels.contact}
              </a>
            </p>
          </GridCell>
        </Grid>
      </Section>
    </main>
  )
}

/** `/contact` — the desk, the address, the hours, and the two links that open the door. */
export function ContactBody({ facts, copy, locale, napCopy }: SpaBodyProps) {
  return (
    <main>
      <DesignSystemStyles />
      <PageHeader
        copy={copy}
        locale={locale}
        current="contact"
        title={copy.contact.title}
        lede={copy.contact.lede}
      />

      <Section>
        <Grid>
          <GridCell>
            <Measure cap="body" as="div">
              <QuestionSections sections={contactSections(copy, { facts, locale })} />
            </Measure>
            <PlaceLinks facts={facts} copy={copy} />
          </GridCell>
        </Grid>
      </Section>

      <Section>
        <Grid>
          <GridCell span="wide">
            <NapBlock copy={napCopy} facts={facts} />
          </GridCell>
        </Grid>
      </Section>

      <Section>
        <Grid>
          <GridCell>
            <p className="be-actions">
              <a className="be-action be-action--quiet" href={menuPath(locale)}>
                {copy.labels.menu}
              </a>
              <a className="be-action be-action--quiet" href={faqPath(locale)}>
                {copy.labels.faq}
              </a>
            </p>
          </GridCell>
        </Grid>
      </Section>
    </main>
  )
}

export interface AboutBodyProps extends ContentPageProps {
  /** The `pages` document with slug `about`, when an editor has published one. */
  readonly pages: readonly EditorialPage[]
}

/**
 * `/about` — what this place is, and how to tell it apart from the airport spa of a similar name.
 *
 * The editorial body is a `pages` document with the slug `about`, and there is none: the collection holds no
 * rows. So the page renders what the business's own records say — the trading name, the registered entity,
 * the district and the size of the menu — and adds the editor's prose above it the moment one exists. That
 * ordering is the decision: the derived answers are the ones that cannot go stale, and an about page that
 * consisted only of a missing CMS document would be a 200 with nothing on it.
 */
export function AboutBody({ facts, copy, locale, pages }: AboutBodyProps) {
  const page = editorialPageFor(pages, 'about')
  return (
    <main>
      <DesignSystemStyles />
      <PageHeader
        copy={copy}
        locale={locale}
        current="about"
        title={page?.title ?? copy.about.title}
        lede={page?.lede ?? copy.about.lede}
      />

      {page === undefined ? null : (
        <Section>
          <Grid>
            <GridCell>
              <Measure cap="body" as="div">
                {page.paragraphs.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </Measure>
            </GridCell>
          </Grid>
        </Section>
      )}

      <Section>
        <Grid>
          <GridCell>
            <Measure cap="body" as="div">
              <QuestionSections sections={aboutSections(copy, { facts, locale })} />
            </Measure>
            <p className="be-actions">
              <a className="be-action be-action--quiet" href={menuPath(locale)}>
                {copy.labels.menu}
              </a>
              <a className="be-action be-action--quiet" href={pricingPath(locale)}>
                {copy.labels.prices}
              </a>
              <a className="be-action be-action--quiet" href={contactPath(locale)}>
                {copy.labels.contact}
              </a>
            </p>
          </GridCell>
        </Grid>
      </Section>
    </main>
  )
}

export interface FaqBodyProps {
  readonly copy: ContentCopy
  readonly locale: Locale
  /** The published `faq_entries` rows: the same array the `FAQPage` node is built from. */
  readonly entries: readonly FaqEntry[]
}

/**
 * `/faq` — the questions, from the rows, and nothing else.
 *
 * The page's headings **are** the collection: one `<h2>` per published entry, its answer as the `<p>`
 * immediately after it, in the editorial order the admin's drag-and-drop writes. There are no page-level
 * questions of its own, and that is what makes the acceptance criterion checkable as an equality rather than
 * as an overlap — the count of headings, the count of `Question` nodes and the count of rows are one number.
 *
 * With no rows it renders the stated absence. An empty `FAQPage` node is invalid (Google requires at least one
 * `Question`) and `faqPageNode` returns nothing for an empty list, so the page and the graph agree about the
 * emptiness too.
 */
export function FaqBody({ copy, locale, entries }: FaqBodyProps) {
  const sections = faqSections(entries)
  return (
    <main>
      <DesignSystemStyles />
      <PageHeader
        copy={copy}
        locale={locale}
        current="faq"
        title={copy.faq.title}
        lede={copy.faq.lede}
      />

      <Section>
        <Grid>
          <GridCell>
            <Measure cap="body" as="div">
              {sections.length === 0 ? <p>{copy.faq.empty}</p> : null}
              <QuestionSections sections={sections} />
            </Measure>
            <p className="be-actions">
              <a className="be-action be-action--quiet" href={contactPath(locale)}>
                {copy.labels.contact}
              </a>
              <a className="be-action be-action--quiet" href={menuPath(locale)}>
                {copy.labels.menu}
              </a>
              <a className="be-action be-action--quiet" href={pricingPath(locale)}>
                {copy.labels.prices}
              </a>
            </p>
          </GridCell>
        </Grid>
      </Section>
    </main>
  )
}

export interface JournalBodyProps extends ContentPageProps {
  readonly posts: readonly JournalPost[]
  /** `compliance_notices.medical_disclaimer`, or null while the owner has not written it. */
  readonly disclaimer: string | null
}

/**
 * `/journal` — the index.
 *
 * Every post carries its author, its reviewer and its date, because a post missing any of the three cannot be
 * published at all (`assertJournalPostPublishable`). The list is empty today and the page says so in the
 * answer to "What is in the journal?" rather than rendering an empty region: docs/09 §3's rule about the "no
 * availability" state applies to any empty list — it is a designed state, not an absent one.
 *
 * `/journal/[slug]` is not a route yet, and the manifest NOTE says why: a publishable post needs the name of
 * the person who wrote it and the name of the person who checked it, and this build does not invent a name.
 * So a post's title is not a link — there is nothing to link to — and the index renders the standfirst
 * instead. The day the route lands, this is where the link goes.
 */
export function JournalBody({ facts, copy, locale, posts, disclaimer }: JournalBodyProps) {
  return (
    <main>
      <DesignSystemStyles />
      <PageHeader
        copy={copy}
        locale={locale}
        current="journal"
        title={copy.journal.title}
        lede={copy.journal.lede}
      />

      <Section>
        <Grid>
          <GridCell span="wide">
            {posts.length === 0 ? (
              <p>{copy.labels.journalEmpty}</p>
            ) : (
              <ul>
                {posts.map((post) => (
                  <li key={post.slug}>
                    <strong>{post.title}</strong>
                    {post.standfirst === null ? null : <span>{post.standfirst}</span>}
                    <span>{copy.labels.byline(post.byline ?? '')}</span>
                    <span>{copy.labels.reviewedBy(post.reviewedBy ?? '')}</span>
                    <span>{copy.labels.publishedOn(post.publishedOn ?? '')}</span>
                  </li>
                ))}
              </ul>
            )}
          </GridCell>
        </Grid>
      </Section>

      {/* The medical-disclaimer pattern. It renders when a post on this page is health-adjacent and the
          owner has written the wording; a health-adjacent post with no wording written cannot be published,
          so the two states this region has are "nothing health-adjacent here" and "the disclaimer". The
          heading says "Health note" rather than naming the field, because `medical` is on
          `regulatory_profile.banned_claim_terms` under the seeded profile and this copy is linted. */}
      {disclaimer === null || !anyHealthAdjacent(posts) ? null : (
        <Section>
          <Grid>
            <GridCell>
              <aside aria-label={copy.labels.healthNote}>
                <Measure cap="body" as="div">
                  <h2>{copy.labels.healthNote}</h2>
                  <p>{disclaimer}</p>
                </Measure>
              </aside>
            </GridCell>
          </Grid>
        </Section>
      )}

      <Section>
        <Grid>
          <GridCell>
            <Measure cap="body" as="div">
              <QuestionSections sections={journalSections(copy, { facts, locale, posts })} />
            </Measure>
            <p className="be-actions">
              <a className="be-action be-action--quiet" href={menuPath(locale)}>
                {copy.labels.menu}
              </a>
              <a className="be-action be-action--quiet" href={faqPath(locale)}>
                {copy.labels.faq}
              </a>
            </p>
          </GridCell>
        </Grid>
      </Section>
    </main>
  )
}
