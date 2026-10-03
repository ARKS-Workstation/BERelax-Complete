/**
 * `/therapists/<slug>` — one therapist, in English. docs/09 §1 calls it the differentiator.
 *
 * ## Three statuses from one segment, and all three are ADR 0020
 *
 * - **200** for a therapist with a display name and a recorded photography consent.
 * - **A permanent redirect** for one who has left. The row is `redirect_map`'s, written by
 *   `archiveTherapist` inside the transaction that retires them, so there is no second place a redirect
 *   can be forgotten. docs/09 §2: *"Do not 404 it"* — the page has inbound links, accumulated reviews and
 *   rankings, and the business owns the client relationship.
 * - **404** for every other slug, including a therapist who exists and may not be published. Not a
 *   redirect to the index: a 301 from every unpublished therapist's slug would tell a crawler those URLs
 *   are real pages that moved, and it would leak that a person by that name works here.
 *
 * `permanentRedirect` is Next's 308 rather than the 301 the row records, for the reason
 * `treatments/[slug]/page.tsx` sets out at length: `redirect()` answers 307, which is *temporary*, and 308
 * and 301 are the same signal to every search engine. The stored `status_code` stays 301 because that is
 * what a CDN rule generated from the same table would serve.
 *
 * ## Why there is no `generateStaticParams`
 *
 * The registry declares this route `dynamic`, and the reason is consent rather than performance: a
 * prerendered 200 carrying somebody's name is a cached copy of a page a consent withdrawal has to remove,
 * and `revalidatePath` is a door somebody has to remember to walk through. The registry entry carries the
 * argument and `route-spine.itest.ts` asserts the route is absent from the prerender manifest.
 */

import type { Metadata, Route } from 'next'
import { notFound, permanentRedirect } from 'next/navigation'
import { routeMetadata } from '../../../../../src/routes/alternates.ts'
import { pageGraph } from '../../../../../src/seo/graph-input.ts'
import { StructuredData } from '../../../../../src/seo/structured-data.tsx'
import { bookWithHref, qualificationPhrase } from '../../../../../src/therapists/content.ts'
import { THERAPISTS_COPY_EN } from '../../../../../src/therapists/copy-en.ts'
import {
  candidateFor,
  knowsAboutForRow,
  nextOpenTradingDate,
  resolveTherapist,
  therapistAvailability,
  therapistPageData,
} from '../../../../../src/therapists/read.ts'
import { RouteNav } from '../../../../_routes/route-nav.tsx'
import { TherapistBody } from '../../../../_therapists/pages.tsx'

export const dynamic = 'force-dynamic'

interface TherapistParams {
  readonly params: Promise<{ readonly slug: string }>
}

export async function generateMetadata({ params }: TherapistParams): Promise<Metadata> {
  const { slug } = await params
  const { facts, therapists } = await therapistPageData()
  const resolution = await resolveTherapist(therapists, slug)
  // A title for a page that is about to 301 or 404 is never read by anybody, and it must not be a name:
  // the only reason this branch is reached is that no therapist may be published at this slug.
  const name =
    resolution.kind === 'render'
      ? (resolution.row.displayName ?? facts.names.display)
      : facts.names.display
  return {
    title: `${name} — ${facts.names.display}`,
    description:
      resolution.kind === 'render'
        ? `${name}, and what they are trained in.`
        : THERAPISTS_COPY_EN.index.lede,
    ...routeMetadata('therapist', 'en', { slug }),
  }
}

export default async function TherapistPage({ params }: TherapistParams) {
  const { slug } = await params
  const { facts, licenceClass, therapists, serviceSkills } = await therapistPageData()
  const resolution = await resolveTherapist(therapists, slug)
  // `as Route` is `typedRoutes`: Next types a redirect target as a known route literal, and this one comes
  // from `redirect_map` — a row, not a literal. The row's shape is the schema's
  // (`redirect_map_target_path_absolute`), and its one-hop property is `redirect_map_one_hop`'s.
  if (resolution.kind === 'redirect') permanentRedirect(resolution.target as Route)
  if (resolution.kind === 'not_found') notFound()

  const row = resolution.row
  // The guard has passed, so the name is there. Read once and passed to both the graph and the body, which
  // is what keeps the `Person` node and the `<h1>` from being two reads of one column.
  const displayName = row.displayName ?? ''
  const graph = pageGraph({
    id: 'therapist',
    locale: 'en',
    facts,
    licenceClass,
    breadcrumb: { home: THERAPISTS_COPY_EN.home, page: displayName },
    includeCatalogue: false,
    // `knowsAbout` is the live services this therapist's specialisms resolve to, and `knowsAboutForRow`
    // throws naming the specialism when one resolves to nothing — a `Person` claiming expertise in an
    // archived treatment sends a client to the desk asking for it.
    therapists: [
      {
        ...candidateFor(row),
        skills: [...knowsAboutForRow(row, facts, serviceSkills)],
      },
    ],
    params: { slug },
  })
  const now = Date.now()
  const tradingDate = await nextOpenTradingDate(now)
  // Null is a horizon with no open day in it. The page says so rather than previewing a date
  // `business_day` does not hold, which the solver would answer "closed" for the wrong reason.
  const availability =
    tradingDate === null ? null : await therapistAvailability(row, tradingDate, now)
  return (
    <>
      <StructuredData graph={graph} />
      <RouteNav id="therapist" locale="en" params={{ slug }} />
      <TherapistBody
        facts={facts}
        row={row}
        displayName={displayName}
        knowsAbout={knowsAboutForRow(row, facts, serviceSkills)}
        languages={row.languages}
        qualifications={qualificationPhrase(
          row.skills,
          THERAPISTS_COPY_EN.skills,
          THERAPISTS_COPY_EN.skillJoin,
        )}
        availability={availability}
        bookHref={bookWithHref(row, 'en')}
        copy={THERAPISTS_COPY_EN}
        locale="en"
      />
    </>
  )
}
