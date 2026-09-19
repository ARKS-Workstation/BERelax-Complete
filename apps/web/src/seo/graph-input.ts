/**
 * The graph for one registry route, in one locale. Pure.
 *
 * Pure so that every claim about a page's structured data is a unit test rather than a render: the
 * integration suite builds the expected graph with these functions from the same facts the route rendered
 * from and compares it with the block the server actually served, which is the only form of "every block
 * matches a builder output" that is not circular.
 *
 * It is a separate module from `structured-data.tsx` for a mechanical reason as well as a conceptual one:
 * `apps/web/tsconfig.json` sets `jsx: "preserve"`, so vitest cannot parse a `.tsx` from this application and
 * a unit test cannot import one. Anything a unit test must reach lives here.
 */
import {
  type BreadcrumbStep,
  buildStructuredDataGraph,
  type FaqEntry,
  type StructuredDataGraph,
  type StructuredDataInput,
  type TherapistCandidate,
} from '@berelax/core'
import type { Facts } from '@berelax/shared'
import { type Locale, localisedPath } from '../i18n/locales.ts'
import { absoluteUrl, siteOrigin } from '../routes/alternates.ts'
import { type RouteId, routeById } from '../routes/registry.ts'

/** The two labels a trail needs, in the locale of the document. Copy belongs to the route. */
export interface BreadcrumbCopy {
  /** What this locale calls its home page. */
  readonly home: string
  /** What this page is called. */
  readonly page: string
}

/**
 * The trail for a route, with absolute URLs from the registry.
 *
 * Home first, then the page. The URLs come from `absoluteUrl` — the same function the canonical link and
 * the `hreflang` set use — so a breadcrumb cannot point at a path the canonicaliser would redirect, which
 * is the most confident way to tell a crawler to ignore what a page said about itself.
 *
 * Returns one step for the home route itself, which `breadcrumbListNode` turns into no node at all: a trail
 * whose only item is the page it is on tells a consumer nothing the URL did not.
 */
export function breadcrumbTrailFor(
  id: RouteId,
  locale: Locale,
  copy: BreadcrumbCopy,
): readonly BreadcrumbStep[] {
  const route = routeById(id)
  const home: BreadcrumbStep = { name: copy.home, url: absoluteUrl(localisedPath('/', locale)) }
  if (route.path === '/') return [home]
  return [home, { name: copy.page, url: absoluteUrl(localisedPath(route.path, locale)) }]
}

export interface PageGraphOptions {
  readonly id: RouteId
  readonly locale: Locale
  readonly facts: Facts
  /** `regulatory_profile_current.licence_class`, from the row. Never defaulted — see `validateGraph`. */
  readonly licenceClass: string
  readonly breadcrumb: BreadcrumbCopy
  /**
   * Whether this page publishes the treatment menu.
   *
   * True on a page whose subject is the business and its menu. False elsewhere: 11 `Service` nodes and 35
   * `Offer`s in every document is the same information a consumer has to reconcile once per page, and it
   * makes the page's own subject harder for a machine to identify.
   */
  readonly includeCatalogue: boolean
  /**
   * Therapists to consider for a `Person` node.
   *
   * Empty today, and the emptiness is a fact about the schema rather than a shortcut: `employee` has no
   * `display_name` column at all (0030) and there is no photography consent register, so no candidate can
   * pass ADR 0020's guard. `personNodesFor` filters on both, so the day the columns exist the nodes appear
   * without this call site changing. `structured-data.itest.ts` asserts the column really is absent, so
   * this cannot quietly stay empty after somebody adds it.
   */
  readonly therapists?: readonly TherapistCandidate[]
  /** `faq_entries` rows, answers flattened to text. Empty until a route renders the FAQ. */
  readonly faq?: readonly FaqEntry[]
}

/**
 * The graph input for one registry route, in one locale. Pure.
 *
 * Pure so the integration test can build the expected graph from the same facts the route rendered from and
 * compare the two, which is the only form of "every block matches a builder output" that is not circular.
 *
 * `heroImage` and `heroVideo` are `null` here rather than absent, and stated rather than omitted:
 *
 *   - **No image.** `assets/media/manifest.json` holds four hero stills, but no derivative is committed —
 *     `build/budgets.json` says the derivative budgets are built at check time from the originals — and no
 *     route serves one. An `ImageObject` whose `contentUrl` 404s is a claim about the page that a crawler
 *     checks and fails.
 *   - **No video.** There is no video. All 25 assets in the library are stills; the prototype's `#video`
 *     anchor pointed at an embed on somebody else's platform, which is not an asset this business owns.
 *
 * `sameAsProfiles` is likewise absent rather than guessed. `organizationNode` always publishes the site's
 * own origin; the GBP, TripAdvisor and social URLs have no value in the database and
 * `SAME_AS_UNANSWERED` in `@berelax/core` names each one with the open question that holds it. A plausible
 * TripAdvisor URL would bind this entity to somebody else's listing, which is the exact collision `sameAs`
 * is here to prevent.
 */
export function graphInputFor(options: PageGraphOptions): StructuredDataInput {
  const origin = siteOrigin()
  return {
    facts: options.facts,
    pageUrl: absoluteUrl(localisedPath(routeById(options.id).path, options.locale)),
    origin,
    licence: asLicenceClass(options.licenceClass),
    includeCatalogue: options.includeCatalogue,
    therapists: options.therapists ?? [],
    faq: options.faq ?? [],
    breadcrumb: breadcrumbTrailFor(options.id, options.locale, options.breadcrumb),
    heroImage: null,
    heroVideo: null,
  }
}

/** The graph for one registry route. */
export function pageGraph(options: PageGraphOptions): StructuredDataGraph {
  return buildStructuredDataGraph(graphInputFor(options))
}

/**
 * The licence class as `@berelax/core`'s union, or a refusal.
 *
 * `regulatory_profile.licence_class` is a PostgreSQL enum and `LicenceClass` in `@berelax/core` mirrors it,
 * because `packages/core` may not import `packages/db`. This is the edge that may see both, so this is where
 * the narrowing happens — and it **throws** on an unrecognised value rather than falling back to
 * `'unconfirmed'`.
 *
 * The fallback is the tempting choice and it is wrong in one specific way: an unrecognised value means the
 * enum gained a member that no vocabulary decision covers, and defaulting to the strict branch would publish
 * wellness vocabulary for a business whose licence had just been confirmed as something else — silently, and
 * for as long as it took somebody to notice. A page that fails to render is noticed the same day.
 */
function asLicenceClass(value: string): StructuredDataInput['licence'] {
  if (value === 'unconfirmed' || value === 'wellness' || value === 'healthcare') return value
  throw new Error(
    `regulatory_profile.licence_class is '${value}', which no schema.org vocabulary decision covers. ` +
      'Add a case to businessTypesFor, serviceTypesFor and personTypesFor in ' +
      'packages/core/src/seo/jsonld/vocabulary.ts before this class can be published.',
  )
}
