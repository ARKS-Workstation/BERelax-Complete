import type { CompliancePolicy } from '@berelax/core'
import { readCompliancePolicy, readPremisesFacts, type Sql } from '@berelax/db'
import { DEFAULT_LOCALE, LOCALES, localisedPath } from '../i18n/locales.ts'
import { absoluteUrl, siteOrigin } from '../routes/alternates.ts'
import { fillParams, isParameterised, ROUTES, routeByPath } from '../routes/registry.ts'
import { buildFacts, factsEtag } from './build.ts'
import { type LlmsPage, publishLlmsTxt } from './llms.ts'
import { buildRobotsTxt } from './robots.ts'

/**
 * The three machine surfaces, as functions of their dependencies.
 *
 * `route.ts` beside each one does the wiring and nothing else, exactly as `app/api/v1/otp/route.ts` and
 * its `handler.ts` are split: `loadConfig()` throws when `DATABASE_URL` is absent and `next build` imports
 * every route module to collect its exports, so a connection built at module scope fails the build on any
 * machine without a database — including CI, where the build step runs before the migrations. The split
 * also means `apps/web/src/facts.itest.ts` drives these against a real PostgreSQL without starting a
 * server, which is where the ETag and the 304 are actually decided.
 *
 * ## Why all three are dynamic
 *
 * `/api/facts` and `/llms.txt` read the premises row, and a prerendered copy of either would freeze the
 * address at build time — the exact staleness this unit exists to remove. `/robots.txt` reads
 * `SITE_ORIGIN` and the route registry; it *could* be prerendered, and is not, because a build promoted
 * between environments carries the origin it was built with (see the guard in
 * `apps/web/src/route-spine.itest.ts`) and a `Sitemap:` line naming the wrong host is worse than none.
 * Three surfaces, one rule: nothing about the business is baked into a build artefact.
 */

/** Everything these handlers need from the outside. Supplied by `route.ts`, faked by the tests. */
export interface FactsDeps {
  readonly sql: Sql
  /** ISO 8601. An argument so a test can build the same payload twice and compare the ETags. */
  readonly now: () => string
}

/** 404 rather than 500 when the premises singleton is absent. See {@link missingPremises}. */
const SEED_HINT =
  'The premises singleton has no row, so there are no facts to publish. Run `pnpm seed` against this ' +
  'database: packages/db/src/seed/premises.ts writes it from docs/13.'

/**
 * What to answer when there is no row.
 *
 * **503, not 200 with an empty body.** A fact sheet is consumed by machines that cache and quote it, and a
 * 200 carrying a payload with no address teaches a crawler that this business has no address — which is
 * then repeated with total confidence, and revalidated from cache for as long as the crawler pleases. A
 * 503 says "ask again", which is true: the row arrives with the seed.
 *
 * `Retry-After` is deliberately short. This state is a deployment that has not been seeded, not an outage.
 */
function missingPremises(): Response {
  return new Response(SEED_HINT, {
    status: 503,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60' },
  })
}

/**
 * `GET /api/facts`.
 *
 * The conditional-request half, which is the part worth reading:
 *
 *   - the ETag is a hash of the facts with `generatedAt` removed (`factsEtag`), so it changes when a fact
 *     changes and not once a second;
 *   - `If-None-Match` is compared after stripping a `W/` prefix from both sides, because a proxy may
 *     re-quote a weak validator as strong and RFC 9110 §8.8.3.2 asks for a weak comparison here;
 *   - a 304 carries the ETag and the caching headers and **no body**, which is what makes it cheap.
 *
 * `Cache-Control` is a short `max-age` with `stale-while-revalidate`: the facts change when an owner edits
 * a setting, which is rare, but when it happens the correction has to reach an assistant's next crawl
 * rather than next week. `public` because there is nothing private here by construction.
 */
export async function factsResponse(deps: FactsDeps, request: Request): Promise<Response> {
  const read = await readPremisesFacts(deps.sql)
  if (read === null) return missingPremises()

  const facts = buildFacts(read, { generatedAt: deps.now(), origin: siteOrigin() })
  const etag = factsEtag(facts)
  const headers: Record<string, string> = {
    etag,
    'cache-control': 'public, max-age=300, stale-while-revalidate=3600',
    // The fact sheet is meant to be read by anything, including a browser-side tool on another origin.
    // There is no credential and no private field in the payload, so there is nothing for an origin
    // restriction to protect.
    'access-control-allow-origin': '*',
    vary: 'accept-encoding',
  }

  const weak = (value: string): string => value.replace(/^W\//, '').trim()
  const inbound = request.headers.get('if-none-match')
  if (inbound !== null) {
    const matched = inbound
      .split(',')
      .map((candidate) => weak(candidate))
      .some((candidate) => candidate === weak(etag) || candidate === '*')
    if (matched) return new Response(null, { status: 304, headers })
  }

  return new Response(JSON.stringify(facts, null, 2), {
    status: 200,
    headers: { ...headers, 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * The pages `/llms.txt` names, read off the route registry.
 *
 * Indexable documents only, in the default locale, with the other locales listed as alternates. Three
 * filters and none of them is a list: a route that is `indexable: false` is a development or admin surface
 * and naming it here would undo the policy the registry declares; a handler has no document to read; and
 * the CMS is excluded from the registry altogether. docs/09 §1's eleven planned routes therefore appear
 * here on the day their unit lands, with no change to this file — which is the same property W-SITE-01
 * built the registry for.
 */
export function llmsPages(catalogue: readonly CataloguePage[] = []): readonly LlmsPage[] {
  const pages: LlmsPage[] = []
  for (const route of ROUTES) {
    if (route.kind !== 'document' || !route.indexable) continue
    const alternatesOf = (params: Readonly<Record<string, string>>): readonly string[] =>
      LOCALES.filter((locale) => locale !== DEFAULT_LOCALE)
        .filter((locale) => route.locales.includes(locale))
        .map((locale) => absoluteUrl(fillParams(localisedPath(route.path, locale), params)))

    if (!isParameterised(route.path)) {
      pages.push({
        // The registry id, spelled for a reader: `kitchen-sink` -> `Kitchen sink`. Derived rather than a
        // second field, so a page cannot be listed here under a name the registry does not know.
        label: route.id.replaceAll('-', ' ').replace(/^./, (first) => first.toUpperCase()),
        url: absoluteUrl(localisedPath(route.path, DEFAULT_LOCALE)),
        alternates: alternatesOf({}),
      })
      continue
    }
    // A parameterised route is a pattern, and `/llms.txt` is a list of URLs a reader may fetch. Listing the
    // pattern would publish `https://…/treatments/[slug]` as a page — the one failure this file exists to
    // avoid, since the whole point of it is that an assistant fetches what it names. The concrete pages come
    // from the catalogue, which the caller has already read; with none, the route contributes nothing rather
    // than a URL that 404s.
    for (const page of catalogue) {
      pages.push({
        label: page.label,
        url: absoluteUrl(
          fillParams(localisedPath(route.path, DEFAULT_LOCALE), { slug: page.slug }),
        ),
        alternates: alternatesOf({ slug: page.slug }),
      })
    }
  }
  return pages
}

/** One catalogue-derived page, for the parameterised route `llmsPages` expands. */
export interface CataloguePage {
  readonly slug: string
  /** The public display name, which is what a reader and an assistant look for. */
  readonly label: string
}

/**
 * `GET /llms.txt`, as `text/plain`.
 *
 * Markdown content served as `text/plain` and not as `text/markdown`, which looks like a mistake and is
 * the convention: the file is fetched by crawlers that treat an unknown media type as a download, and
 * `text/plain` is the only type every one of them renders. The acceptance criterion names it explicitly.
 *
 * The body is linted before it is served (`publishLlmsTxt`) against the profile in force, so a refusal is
 * a 500 in the logs rather than published copy making a claim the licence does not carry.
 */
export async function llmsResponse(deps: FactsDeps): Promise<Response> {
  const read = await readPremisesFacts(deps.sql)
  if (read === null) return missingPremises()
  const policy: CompliancePolicy = await policyFor(deps.sql)
  const facts = buildFacts(read, { generatedAt: deps.now(), origin: siteOrigin() })
  const body = publishLlmsTxt(
    {
      facts,
      origin: siteOrigin(),
      // The eight treatment pages by name, so the file names what it links to. The labels are the
      // catalogue's linted public display names, never composed here.
      pages: llmsPages(
        facts.catalogue.services.map((service) => ({ slug: service.slug, label: service.name })),
      ),
    },
    policy,
  )
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=300, stale-while-revalidate=3600',
    },
  })
}

/**
 * The compliance policy, mapped across the boundary.
 *
 * `readCompliancePolicy` returns `CompliancePolicyRow` from `@berelax/db` and the lint takes
 * `CompliancePolicy` from `@berelax/core`. They are structurally identical and deliberately two types:
 * `packages/db` may not import `packages/core`, so the copy happens at an edge that may import both. This
 * is that edge.
 */
async function policyFor(sql: Sql): Promise<CompliancePolicy> {
  const row = await readCompliancePolicy(sql)
  return {
    bannedClaimTerms: row.bannedClaimTerms,
    permittedPublicTitles: row.permittedPublicTitles,
    medicalClaimsPermitted: row.medicalClaimsPermitted,
  }
}

/** The path a sitemap index would be served from, once one exists. */
export const SITEMAP_PATH = '/sitemap.xml'

/**
 * `GET /robots.txt`, as `text/plain`.
 *
 * Reads nothing from the database: a crawl policy is a property of the URL space, and the URL space is the
 * route registry. The `Sitemap:` line appears only when the registry declares a route at
 * {@link SITEMAP_PATH} — W-SITE-08's — because the registry is in exact bijection with the filesystem, so
 * "the registry knows that path" and "something serves it" are the same statement.
 */
export function robotsResponse(): Response {
  const declared = routeByPath(SITEMAP_PATH) !== undefined
  return new Response(
    buildRobotsTxt({ origin: siteOrigin(), sitemapPath: declared ? SITEMAP_PATH : null }),
    {
      status: 200,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        // Longer than the fact sheet's: this file changes when a route's policy changes, which is a
        // deployment, and a crawler re-reads it on its own schedule anyway.
        'cache-control': 'public, max-age=3600',
      },
    },
  )
}
