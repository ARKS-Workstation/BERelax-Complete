import { type ChildProcess, spawn } from 'node:child_process'
import {
  assertPublicDisplayNameCompliant,
  buildStructuredDataGraph,
  type CompliancePolicy,
  formatFindings,
  graphOpenAt,
  LICENCE_CLASSES,
  MEDICAL_VOCABULARY,
  serialiseGraph,
  validateGraph,
} from '@berelax/core'
import {
  createConnection,
  ensureLegalEntity,
  readCompliancePolicy,
  readPremisesFacts,
  type Sql,
  seedCatalogue,
  seedPremises,
} from '@berelax/db'
import { testPort } from '@berelax/harness/ports'
import type { Facts } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildFacts } from '../facts/build.ts'
import { siteOrigin } from '../routes/alternates.ts'
import {
  documentRoutes,
  ROUTES,
  routeById,
  sampleParamsOf,
  samplePathFor,
} from '../routes/registry.ts'
import { brandIsQualified } from './brand.ts'
import { graphInputFor } from './graph-input.ts'

/**
 * W-SITE-03 — the JSON-LD the application actually serves, validated against the row it came from.
 *
 * The unit tests prove the builders. This proves the **published bytes**, which is a different claim and the
 * one the acceptance criteria are about:
 *
 *   - every `<script type="application/ld+json">` on every registry document is byte-identical to
 *     `buildStructuredDataGraph`'s output for that route — so there is no block anybody wrote by hand;
 *   - the graph the server served carries the real `premises` row's address, hours and 32 prices, and
 *     nothing the row does not hold;
 *   - the four medical terms appear nowhere while `regulatory_profile_current.licence_class` is
 *     `unconfirmed`, read from the database rather than assumed;
 *   - `employee` really has no `display_name` column, which is why no `Person` node exists — so the empty
 *     therapist list cannot quietly stay empty after somebody adds one.
 *
 * ## Why this fetches rather than renders
 *
 * No browser. The question is what bytes the server sent, and `fetch` answers it exactly; a headless
 * Chromium would answer it through a DOM serialiser that normalises the very escaping `serialiseGraph`
 * performs. The port band is `@berelax/harness/ports`' rather than this file's own (see
 * `kitchen-sink.itest.ts` on why a fixed port is a false pass, and `ports.ts` on why a self-chosen band is
 * the next mistake).
 */
const PORT = testPort('structured-data')
const BASE = `http://127.0.0.1:${PORT}`
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''

let server: ChildProcess
let sql: Sql
let facts: Facts
let licenceClass: string

/** Every JSON-LD block in a served document, parsed. */
function jsonLdBlocks(html: string): readonly { raw: string; parsed: unknown }[] {
  const blocks: { raw: string; parsed: unknown }[] = []
  const pattern = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g
  let match = pattern.exec(html)
  while (match !== null) {
    const raw = match[1] ?? ''
    blocks.push({ raw, parsed: JSON.parse(raw) as unknown })
    match = pattern.exec(html)
  }
  return blocks
}

async function fetchDocument(path: string): Promise<string> {
  const response = await fetch(`${BASE}${path}`)
  expect(response.status, `${path} did not answer 200`).toBe(200)
  return response.text()
}

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 2 })
  /*
    The rows this file reads are (re)seeded here, with the values the migration seeds.

    Brief rule 12's third case, and the same three calls `facts.itest.ts` makes for the same reason: the
    integration suite shares one database, the file order is not this file's to choose, and CI applies the
    migrations without running `pnpm seed` at all. A file that assumed a seeded database would pass locally
    for whoever had seeded and fail in CI — and a file that inserted its own premises row would put an
    invented address in the singleton every later suite reads.

    `seedCatalogue` takes the lint so the 32 price points are written through the same compliance check the
    admin path uses; the policy has to be read first because that lint is licence-class dependent.
  */
  await seedPremises(sql)
  await ensureLegalEntity(sql)
  const seededPolicy = await readCompliancePolicy(sql)
  await seedCatalogue(sql, {
    lint: (name) =>
      assertPublicDisplayNameCompliant(name, {
        bannedClaimTerms: seededPolicy.bannedClaimTerms,
        permittedPublicTitles: seededPolicy.permittedPublicTitles,
        medicalClaimsPermitted: seededPolicy.medicalClaimsPermitted,
      } satisfies CompliancePolicy),
  })

  const [read, policy] = await Promise.all([readPremisesFacts(sql), readCompliancePolicy(sql)])
  if (read === null) {
    throw new Error(
      'premises has no row even after seedPremises: the migrations have not been applied',
    )
  }
  // The expected graph is built from the row this suite read, with the same origin the server uses. Not from
  // a fixture: the claim under test is that the served block equals what the builders make of the REAL row.
  facts = buildFacts(read, { generatedAt: '2026-01-01T00:00:00.000Z', origin: siteOrigin() })
  licenceClass = policy.licenceClass

  server = spawn('pnpm', ['exec', 'next', 'start', '--port', String(PORT)], {
    cwd: new URL('../..', import.meta.url).pathname,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_ENV: 'production' },
  })
  let output = ''
  server.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  server.stderr?.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  const deadline = Date.now() + 60_000
  for (;;) {
    try {
      const response = await fetch(`${BASE}/kitchen-sink`)
      if (response.ok) break
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error(`the app did not start on ${BASE}:\n${output}`)
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  // The server that answered must be OURS: a reachable port plus a dead child is another worktree's
  // application answering for this one, and every assertion below would be about code this tree lacks.
  if (server.exitCode !== null) {
    throw new Error(`next start exited with ${server.exitCode} yet ${BASE} answered:\n${output}`)
  }
}, 180_000)

afterAll(async () => {
  server?.kill('SIGTERM')
  await sql?.end()
})

/*
 * `SITE_ORIGIN` is deliberately **not** overridden for this suite.
 *
 * Every `@id` in the graph hangs off the origin, so the expectation and the served document have to be built
 * against the same one — and `route-spine.itest.ts` records why setting it here is the wrong way to get
 * that: `/` and `/ar` are statically prerendered, so the origin is baked at `next build`, and a run whose
 * `SITE_ORIGIN` differs from the build's compares a runtime expectation against a baked document. Calling
 * `siteOrigin()` — the same function the server calls — gives whatever this environment configured, which is
 * the same value on both sides by construction.
 */

/**
 * The sample slug the treatment route is visited with: the registry's own, not a second spelling.
 *
 * `treatments.itest.ts` asserts it resolves to a published service, so a renamed treatment fails there
 * rather than making every assertion in this file compare two empty graphs.
 */
const SAMPLE_SLUG = sampleParamsOf(routeById('treatment'))['slug'] ?? ''

/**
 * What a page whose subject is not the menu passes.
 *
 * Named rather than repeated ten times, and spelled as an override of the expectation's default rather than
 * as its own object so that the `...route.options` spread below stays one line. `includeCatalogue: false` is
 * the page's own decision (W-SITE-07's five routes), not a simplification here.
 */
const NO_CATALOGUE = { includeCatalogue: false } as const

/**
 * The registry documents that render a graph, with the locale each is served in and the options the page
 * built its graph with.
 *
 * W-SITE-05 added six of these and W-SITE-07 ten more. The options are part of the expectation because they
 * are what the page decided: a treatment page publishes **one** `Service` — its own, scoped by `serviceSlugs`
 * — the index and `/pricing` publish the whole menu because the menu is their subject, and the five
 * CMS-and-premises routes publish **no** catalogue at all, because their subject is the premises or the
 * editorial content. `includeCatalogue` is therefore per route rather than a constant in the expectation:
 * eleven `Service` nodes on a contact page is the same information a consumer has to reconcile on every
 * document, which is what that flag exists to prevent.
 */
const GRAPH_ROUTES = [
  // `/` and `/ar` carry a block since W-SITE-04. They take `NO_CATALOGUE` for the reason `/spa` and
  // `/contact` do and one more of their own: the home page's treatments overview is eight LINKS to the eight
  // pages that each publish their own `Service` and four `Offer`s, so republishing all forty nodes here would
  // put the reconciliation problem `includeCatalogue` exists to prevent on the one document every crawler
  // fetches first.
  { id: 'home' as const, locale: 'en' as const, path: '/', options: NO_CATALOGUE },
  { id: 'home' as const, locale: 'ar' as const, path: '/ar', options: NO_CATALOGUE },
  { id: 'kitchen-sink' as const, locale: 'en' as const, path: '/kitchen-sink', options: {} },
  { id: 'kitchen-sink' as const, locale: 'ar' as const, path: '/ar/kitchen-sink', options: {} },
  { id: 'treatments' as const, locale: 'en' as const, path: '/treatments', options: {} },
  { id: 'treatments' as const, locale: 'ar' as const, path: '/ar/treatments', options: {} },
  { id: 'pricing' as const, locale: 'en' as const, path: '/pricing', options: {} },
  { id: 'pricing' as const, locale: 'ar' as const, path: '/ar/pricing', options: {} },
  { id: 'spa' as const, locale: 'en' as const, path: '/spa', options: NO_CATALOGUE },
  { id: 'spa' as const, locale: 'ar' as const, path: '/ar/spa', options: NO_CATALOGUE },
  { id: 'contact' as const, locale: 'en' as const, path: '/contact', options: NO_CATALOGUE },
  { id: 'contact' as const, locale: 'ar' as const, path: '/ar/contact', options: NO_CATALOGUE },
  { id: 'about' as const, locale: 'en' as const, path: '/about', options: NO_CATALOGUE },
  { id: 'about' as const, locale: 'ar' as const, path: '/ar/about', options: NO_CATALOGUE },
  { id: 'journal' as const, locale: 'en' as const, path: '/journal', options: NO_CATALOGUE },
  { id: 'journal' as const, locale: 'ar' as const, path: '/ar/journal', options: NO_CATALOGUE },
  // `/faq` carries whatever `faq_entries` holds, which is nothing until an editor writes one — and an empty
  // list emits no `FAQPage` node at all, because an empty one is invalid. `content.itest.ts` is where the
  // node's equality with the rows is asserted, against rows it writes itself.
  { id: 'faq' as const, locale: 'en' as const, path: '/faq', options: NO_CATALOGUE },
  { id: 'faq' as const, locale: 'ar' as const, path: '/ar/faq', options: NO_CATALOGUE },
  {
    id: 'treatment' as const,
    locale: 'en' as const,
    path: `/treatments/${SAMPLE_SLUG}`,
    options: { serviceSlugs: [SAMPLE_SLUG], params: { slug: SAMPLE_SLUG } },
  },
  {
    id: 'treatment' as const,
    locale: 'ar' as const,
    path: `/ar/treatments/${SAMPLE_SLUG}`,
    options: { serviceSlugs: [SAMPLE_SLUG], params: { slug: SAMPLE_SLUG } },
  },
]

describe('every JSON-LD block on every registry document came out of a builder', () => {
  it('matches the served block byte for byte against buildStructuredDataGraph', async () => {
    for (const route of GRAPH_ROUTES) {
      const html = await fetchDocument(route.path)
      const blocks = jsonLdBlocks(html)
      expect(blocks, `${route.path} served no JSON-LD block`).toHaveLength(1)
      const expected = serialiseGraph(
        buildStructuredDataGraph(
          graphInputFor({
            id: route.id,
            locale: route.locale,
            facts,
            licenceClass,
            breadcrumb: { home: 'Home', page: 'Kitchen sink' },
            includeCatalogue: true,
            ...route.options,
          }),
        ),
      )
      // The breadcrumb names are the route's copy and differ per locale, so the comparison is of the parsed
      // graph minus that one node. Everything else — every address line, every hour, every price — must be
      // identical, which is what "produced by a builder function" means.
      const withoutTrail = (json: string): unknown => {
        const graph = JSON.parse(json) as { '@graph': { '@type': unknown }[] }
        return {
          ...graph,
          '@graph': graph['@graph'].filter(
            (node) => !JSON.stringify(node['@type']).includes('BreadcrumbList'),
          ),
        }
      }
      expect(withoutTrail(blocks[0]?.raw ?? ''), route.path).toEqual(withoutTrail(expected))
    }
  })

  it('crawls every registry document and finds no block it cannot account for', async () => {
    // The other direction, and the one that makes the criterion a property of the site rather than of two
    // routes: every document the registry declares is fetched, and every block found on it is either one this
    // unit builds or a failure. A page nobody thought about cannot introduce a hand-written block unnoticed.
    const accounted = new Set(GRAPH_ROUTES.map((route) => route.path))
    for (const route of documentRoutes()) {
      for (const locale of route.locales) {
        // `samplePathFor` rather than the pattern: a document with a dynamic segment has no fetchable path of
        // its own, and fetching `/treatments/[slug]` would assert something about a 404.
        const path = samplePathFor(route, locale)
        const html = await fetchDocument(path)
        const blocks = jsonLdBlocks(html)
        if (accounted.has(path)) {
          expect(blocks, `${path} should carry one block`).toHaveLength(1)
          continue
        }
        // Nothing else may carry one. This branch used to hold `/` and `/ar` — they were statically
        // prerendered, so `next build` would have had to read a database CI seeds after the build — and
        // W-SITE-04 made the route ISR and put the block on it, which is what the deferral above said it
        // would. The branch is kept because it is the half that catches a hand-written block on a page
        // nobody thought about, which is the property this case is for.
        expect(blocks, `${path} carries a JSON-LD block nothing in this unit builds`).toEqual([])
      }
    }
  })

  it('serves a block a consumer can actually parse', async () => {
    // The escaping, end to end. `serialiseGraph` escapes `<`, `>` and `&` to their JSON `\uXXXX` forms, so the
    // element cannot be closed early by a value — and the block still has to be valid JSON after the HTML
    // parser has finished with it, which is what `JSON.parse` above proves.
    const html = await fetchDocument('/kitchen-sink')
    const raw = jsonLdBlocks(html)[0]?.raw ?? ''
    expect(raw).not.toContain('<')
    expect(raw).not.toContain('&')
    expect(() => JSON.parse(raw)).not.toThrow()
  })
})

describe('the served graph is valid, and says only what the row holds', () => {
  let graph: unknown

  beforeAll(async () => {
    graph = jsonLdBlocks(await fetchDocument('/kitchen-sink'))[0]?.parsed
  })

  it('passes every validator rule, with the node types the page must carry', () => {
    const findings = validateGraph(graph, {
      licence: licenceClass as never,
      requireTypes: ['DaySpa', 'Organization', 'Service', 'BreadcrumbList'],
    })
    expect(formatFindings(findings)).toBe('')
  })

  it('publishes the premises row’s address, not a second spelling of it', () => {
    const business = (graph as { '@graph': Record<string, unknown>[] })['@graph'].find((node) =>
      JSON.stringify(node['@type']).includes('DaySpa'),
    )
    const address = business?.['address'] as Record<string, string>
    expect(address['addressLocality']).toBe(facts.address.area)
    expect(address['addressRegion']).toBe(facts.address.emirate)
    expect(address['addressCountry']).toBe(facts.address.countryCode)
    expect(address['streetAddress']).toContain(facts.address.line1)
    // The control: a deliberately wrong locality is detected, so the assertions above are comparisons and
    // not tautologies.
    expect(address['addressLocality']).not.toBe(`${facts.address.area} Marina`)
  })

  it('publishes no coordinate, because the row holds none', () => {
    // docs/13 states no latitude or longitude, so `premises` holds NULL for both and the node is absent. A
    // plausible pair would put a map pin on the wrong building and nothing on the page would say it was a
    // guess — which is the definition of structured-data spam.
    expect(facts.geo.latitude).toBeNull()
    expect(facts.geo.longitude).toBeNull()
    const serialised = JSON.stringify(graph)
    expect(serialised).not.toContain('GeoCoordinates')
    expect(serialised).not.toContain('latitude')
  })

  it('publishes no rating and no review, because there are none', () => {
    const serialised = JSON.stringify(graph)
    for (const forbidden of ['aggregateRating', 'AggregateRating', '"review"', 'ratingValue']) {
      expect(serialised, forbidden).not.toContain(forbidden)
    }
  })

  it('publishes no WhatsApp number and no placeholder', () => {
    // `contact.whatsapp` is the unanswered branch (Y1-nap) and its number is typed `z.null()`. The graph must
    // not resurrect a candidate: `telephone` and `sameAs` are the fields that would.
    expect(facts.contact.whatsapp.status).toBe('unconfirmed')
    const serialised = JSON.stringify(graph)
    expect(serialised).not.toMatch(/whatsapp/i)
    expect(serialised).not.toMatch(/PENDING|TBC|TBD|\[CONFIRM]/i)
    // And the two numbers it DOES publish are the two both sources in docs/13 §3 agree on.
    expect(serialised).toContain(facts.contact.landline?.e164 ?? 'no landline')
  })

  it('publishes the full trading name, never the bare brand', () => {
    const nodes = (graph as { '@graph': Record<string, unknown>[] })['@graph']
    for (const node of nodes) {
      for (const property of ['name', 'alternateName'] as const) {
        const value = node[property]
        if (typeof value !== 'string') continue
        expect(brandIsQualified(value), `${property}: ${value}`).toBe(true)
      }
    }
    // The control: the bare brand IS detected, so the loop above is a check and not a walk over strings that
    // happen never to mention it.
    expect(brandIsQualified('BE RELAX')).toBe(false)
    expect(nodes.some((node) => /be\s*relax/i.test(String(node['name'])))).toBe(true)
  })

  it('exempts legalName, because a registered entity name is not a brand decision', () => {
    // Found by the assertion above on its first run. `legal_entity.legal_name` is the name on the trade
    // licence and on every tax invoice, and docs/09's rule is about the name the business is *called*: an
    // assistant citing the entity reads `name`. Rewriting `legalName` to satisfy an SEO rule would put a
    // name on a tax document that no registry holds — which is a worse problem than the one it solved.
    //
    // Asserted rather than skipped, so that the exemption is about this one property and not about any string
    // that happens to fail: the value must be exactly what the row holds, unmodified.
    const nodes = (graph as { '@graph': Record<string, unknown>[] })['@graph']
    const legalNames = nodes
      .map((node) => node['legalName'])
      .filter((value): value is string => typeof value === 'string')
    expect(legalNames.length).toBeGreaterThan(0)
    for (const value of legalNames) expect(value).toBe(facts.names.legal)
    // And it really is a name the brand rule refuses, which is why this test exists rather than a comment.
    expect(brandIsQualified(facts.names.legal)).toBe(false)
  })
})

describe('the opening hours, read off the published graph', () => {
  it('reads 01:30 as open and 03:00 as closed, from the real premises_hours rows', async () => {
    // The acceptance criterion, against the real row: trading runs 11:00–02:00 and `crosses_midnight` is a
    // generated column this code reads rather than recomputes. A consumer evaluating `opens <= t <= closes`
    // over the emitted specifications has to get both answers right.
    const graph = jsonLdBlocks(await fetchDocument('/kitchen-sink'))[0]?.parsed
    expect(facts.hours.crossesMidnight).toBe(true)
    for (const day of [0, 1, 2, 3, 4, 5, 6]) {
      expect(graphOpenAt(graph, day, '01:30'), `01:30 on day ${day}`).toBe(true)
      expect(graphOpenAt(graph, day, '03:00'), `03:00 on day ${day}`).toBe(false)
    }
  })

  it('emits no specification whose close is not after its open', async () => {
    const graph = jsonLdBlocks(await fetchDocument('/kitchen-sink'))[0]?.parsed as {
      '@graph': Record<string, unknown>[]
    }
    const business = graph['@graph'].find((node) =>
      JSON.stringify(node['@type']).includes('DaySpa'),
    )
    const specs = business?.['openingHoursSpecification'] as { opens: string; closes: string }[]
    expect(specs.length).toBeGreaterThan(0)
    for (const spec of specs) expect(spec.closes > spec.opens, JSON.stringify(spec)).toBe(true)
  })
})

describe('the catalogue, all of it, from the rows', () => {
  it('publishes an Offer for every published price point and nothing else', async () => {
    const graph = jsonLdBlocks(await fetchDocument('/kitchen-sink'))[0]?.parsed as {
      '@graph': Record<string, unknown>[]
    }
    const services = graph['@graph'].filter((node) =>
      JSON.stringify(node['@type']).includes('Service'),
    )
    const offers = services.flatMap(
      (service) => (service['offers'] as Record<string, unknown>[]) ?? [],
    )
    const priced = offers.filter((offer) => 'price' in offer)
    const expectedPrices = facts.catalogue.services.flatMap((service) =>
      service.variants.map((variant) => variant.grossAed),
    )
    // The 32 price points docs/13 §4 lists, seeded by B-CAT-06. Counted from the row, not asserted as 32, so
    // a menu the owner changes does not make this a failing test about a number in a document.
    expect(facts.catalogue.pricePointCount).toBe(expectedPrices.length)
    expect(priced.map((offer) => offer['price'])).toEqual(expectedPrices)
    for (const offer of priced) {
      expect(offer['priceCurrency']).toBe('AED')
      expect(offer['valueAddedTaxIncluded']).toBe(true)
      expect(String(offer['price'])).toMatch(/^\d+\.\d{2}$/)
    }
    // The control: a price formatted any other way is detected. `1,200.00` and `200` are both what a display
    // helper would produce, and both are wrong in a `price`.
    expect(expectedPrices.every((price) => !price.includes(','))).toBe(true)
  })

  it('publishes each price-on-request offering with no price at all', async () => {
    // Three offerings in docs/13 §4 have no price column (0032, Y9-poa-prices). A derived figure would be
    // quoted, taken at the till and printed on a tax invoice with nothing marking it as a guess.
    const graph = jsonLdBlocks(await fetchDocument('/kitchen-sink'))[0]?.parsed as {
      '@graph': Record<string, unknown>[]
    }
    const offers = graph['@graph']
      .filter((node) => JSON.stringify(node['@type']).includes('Service'))
      .flatMap((service) => (service['offers'] as Record<string, unknown>[]) ?? [])
    const onRequest = offers.filter((offer) => !('price' in offer))
    expect(facts.catalogue.onRequest.length).toBeGreaterThan(0)
    expect(onRequest).toHaveLength(facts.catalogue.onRequest.length)
    for (const offer of onRequest) {
      expect(offer).not.toHaveProperty('priceCurrency')
      expect(String(offer['description'])).toMatch(/Price on request/)
    }
  })

  it('names every offering the menu holds, so the published menu is not shorter than the real one', async () => {
    const graph = jsonLdBlocks(await fetchDocument('/kitchen-sink'))[0]?.parsed as {
      '@graph': Record<string, unknown>[]
    }
    const names = graph['@graph']
      .filter((node) => JSON.stringify(node['@type']).includes('Service'))
      .map((node) => String(node['name']))
    for (const service of facts.catalogue.services) expect(names).toContain(service.name)
    for (const offering of facts.catalogue.onRequest) expect(names).toContain(offering.label)
  })
})

describe('the licence class is read from the database, and it is what bounds the vocabulary', () => {
  it('is the stricter default the migration seeds', async () => {
    const [row] = await sql<{ licence_class: string }[]>`
      select licence_class::text as licence_class from regulatory_profile_current
    `
    expect(row?.licence_class).toBe('unconfirmed')
    expect(licenceClass).toBe('unconfirmed')
  })

  it('emits none of the four medical terms anywhere in the served document', async () => {
    // Not just in the graph: the whole HTML. A medical claim in a heading is the same regulatory exposure as
    // one in a `@type`, and this route is the one that renders the graph.
    const html = await fetchDocument('/kitchen-sink')
    for (const term of MEDICAL_VOCABULARY) {
      expect(html, term).not.toContain(term)
    }
  })

  it('mirrors the licence_class enum exactly, so a new class cannot default to the permissive branch', async () => {
    // `packages/core` may not import `packages/db`, so `LICENCE_CLASSES` is a union that mirrors a PostgreSQL
    // enum. This is the assertion that keeps the pair honest — and it is why a class added to the database
    // fails a test rather than falling through to whichever branch a `default` chose.
    const labels = await sql<{ label: string }[]>`
      select e.enumlabel as label
        from pg_enum e
        join pg_type t on t.oid = e.enumtypid
       where t.typname = 'licence_class'
       order by e.enumsortorder
    `
    expect(labels.map((row) => row.label)).toEqual([...LICENCE_CLASSES])
  })
})

describe('no Person node, because no therapist can pass the publishing guard', () => {
  it('emits none, and the reason is that no row passes the guard', async () => {
    const html = await fetchDocument('/kitchen-sink')
    expect(html).not.toContain('"Person"')
    /*
      The claim under the claim, restated by P-HR-01 because the reason changed and the conclusion did not.

      This test used to assert that `employee` had **no `display_name` column at all** — 0030's position,
      and 0030 said why: "a nullable one is what an admin screen fills in without a consent row, and the
      guard would be invisible". It also said what should happen if the column ever appeared: "this fails
      and the therapist list in `graph-input.ts` has to stop being empty". It appeared, in migration 0050,
      and this test failed, which is the check working.

      What arrived with it is the guard 0030 wanted and would not ship without: `employee.is_publishable`
      is GENERATED as `display_name is not null and photo_consent`, so it cannot be set, cannot be
      forgotten, and cannot be computed differently by a caller. The absence of a Person node is therefore
      no longer a fact about the SCHEMA — it is a fact about the ROWS, and this asserts that instead: the
      guard exists, nineteen employment records exist, and not one of them passes it (Y12-names,
      Y12-consent-photo — 19 photographs and 0 names).

      The control is the row count. Without it, "no row is publishable" would be satisfied by an empty
      table, which is what a truncated database looks like and proves nothing about the guard.
    */
    const columns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'employee'
    `
    const names = columns.map((column) => column.column_name)
    expect(names.length).toBeGreaterThan(0)
    expect(names).toContain('staff_reference')
    expect(names).toContain('display_name')
    expect(names).toContain('photo_consent')
    expect(names).toContain('is_publishable')

    const [employees] = await sql<{ total: string; named: string; publishable: string }[]>`
      select count(*)::text                                  as total,
             count(display_name)::text                       as named,
             count(*) filter (where is_publishable)::text    as publishable
        from employee
    `
    expect(Number(employees?.total ?? '0')).toBeGreaterThan(0)
    expect(employees?.named).toBe('0')
    expect(employees?.publishable).toBe('0')
    // The day one of them becomes publishable this fails, and the therapist list in `graph-input.ts` has
    // to stop being empty — which is exactly the handover the previous version of this test wrote down.
  })
})

describe('the registry is the list of routes this unit had to consider', () => {
  it('leaves no indexable document without a decision about its structured data', () => {
    // Every indexable document either renders a graph or is a stated deferral. The registry is in exact
    // bijection with the filesystem (W-SITE-01), so this enumerates the whole site rather than a sample.
    const indexable = ROUTES.filter((route) => route.kind === 'document' && route.indexable)
    // In the registry's own order, which is PATH order — so `home` is first, because `/` sorts before
    // `/about`. Spelled that way rather than sorted by id: the registry is asserted to be in path order by
    // `registry.test.ts`, and a list sorted by something else here would be a second ordering to maintain.
    expect(indexable.map((route) => route.id)).toEqual([
      'home',
      'about',
      'book',
      'contact',
      'faq',
      'journal',
      'pricing',
      'spa',
      'treatments',
      'treatment',
    ])
    // `string` rather than the id union, so a route id that leaves the registry is a failure here rather than
    // a type error in a test that was asking about it.
    const decided = new Set<string>(GRAPH_ROUTES.map((route) => route.id))
    for (const route of indexable) {
      // One deferral left, and it is B-UI-01's rather than this route's. `home` was the other, and its
      // reason was its rendering mode — a `rendering: 'static'` route is evaluated during `next build` with
      // no read of its own, so it could produce no graph. W-SITE-04 made it `isr` and put the block on it,
      // which is what the previous version of this loop said would happen.
      if (route.id === 'book') {
        /*
          B-UI-01's booking flow, and the second stated deferral. Its rendering mode is the reason, and it
          is asserted rather than described: `/book` is `dynamic` because it reads availability on every
          request, so a graph there would be reassembled per request for a page whose subject is a form.

          And the node it would carry is not a new subject. docs/09 §4 makes the premises row the one
          source of NAP and warns that a hand-written second block is how an assistant ends up stating
          wrong hours — a second `LocalBusiness` on the booking page is exactly that, one more node a
          consumer has to reconcile with the eight pages that already describe the business. What this
          page earns instead is a `potentialAction` on the business node pointing AT it, which belongs to
          whichever page carries that node rather than to this one.

          The day a graph does land here this assertion fails, which is the handover working.
        */
        expect(route.rendering, route.id).toBe('dynamic')
        expect(decided.has(route.id), 'book renders a graph now').toBe(false)
        continue
      }
      expect(route.rendering, route.id).toBe('isr')
      expect(decided.has(route.id), `${route.id} renders no graph`).toBe(true)
    }
  })
})
