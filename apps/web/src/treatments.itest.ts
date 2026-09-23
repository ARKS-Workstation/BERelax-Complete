import {
  assertPublicDisplayNameCompliant,
  type CompliancePolicy,
  formatAmount,
  formatFindings,
  formatMoney,
  grossMoneyFromFils,
  validateGraph,
} from '@berelax/core'
import {
  archiveService,
  changeVariantPrice,
  createConnection,
  deleteService,
  ensureLegalEntity,
  readCompliancePolicy,
  readPremisesFacts,
  refusalOf,
  renameServiceSlug,
  type Sql,
  seedCatalogue,
  seedPremises,
  servicePath,
  TREATMENTS_INDEX_PATH,
  unconfirmedAssumptionRows,
  withUnitOfWork,
} from '@berelax/db'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import type { Facts } from '@berelax/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildFacts } from './facts/build.ts'
import { localisedPath } from './i18n/locales.ts'
import { CATALOGUE_ARTEFACTS, revalidationPathsFor } from './revalidate/catalogue.ts'
import { siteOrigin } from './routes/alternates.ts'
import { priceCellFor, priceRowId, TREATMENT_QUESTIONS } from './treatments/content.ts'
import { treatmentSitemapEntries } from './treatments/sitemap.ts'

/**
 * W-SITE-05 — the catalogue-derived routes, against the built application and a real PostgreSQL.
 *
 * Every claim here is about **served bytes** and cannot be checked any other way:
 *
 *   - eight prerendered routes that answer 200, and 32 price rows across them — the acceptance criterion's
 *     own numbers, read off the catalogue rather than counted by hand;
 *   - every rendered price string equal to its catalogue row through the money helper, over all 32, in both
 *     locales;
 *   - every `<h2>` question-shaped, carrying a stable slug id, and **immediately followed by a `<p>`** — a
 *     property of the DOM, which `content.test.ts` cannot see;
 *   - the `Offer` JSON-LD on a treatment page describing that treatment and no other;
 *   - a slug change answering one permanent hop to a 200, an archived treatment leaving the sitemap and
 *     redirecting to the index, and a delete refused by name while a future booking exists;
 *   - the publish loop: one job run, five artefacts, all of them changed.
 *
 * ## The port, and the server that answers it
 *
 * `startWebServer({ suite: 'treatments' })`, which draws from a band `@berelax/harness/ports` owns and
 * proves disjoint from every other suite's, then ACQUIRES it (`kitchen-sink.itest.ts` records why a fixed
 * port is a false pass: another worktree's application answers and every assertion is about code this tree
 * lacks). It asserts the child is alive after the port answers, for the same reason.
 *
 * ## Why the rows are seeded here
 *
 * Brief rule 12: the integration suite shares one database and the file order is not this file's to choose.
 * `seedPremises`, `ensureLegalEntity` and `seedCatalogue` are the same three calls `facts.itest.ts` and
 * `structured-data.itest.ts` make, with the values the migrations seed — never an invented address.
 */
/**
 * Assigned in `beforeAll`, because the port is ACQUIRED rather than drawn: `startWebServer` binds a
 * candidate from this suite's band and draws again if another worktree already holds it. The ownership
 * check this file used to make by hand — a reachable port plus a dead child is another worktree's
 * application answering for this one — is made there now, for all eleven suites rather than for six.
 */
let BASE = ''
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (!DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const ACTOR = { kind: 'system', label: 'W-SITE-05 itest' } as const

let server: WebServer
let sql: Sql
let facts: Facts
let licenceClass: string
let policy: CompliancePolicy

/** A GET that does not follow redirects, so a hop can be counted. */
async function fetchPath(path: string): Promise<Response> {
  return await fetch(`${BASE}${path}`, { redirect: 'manual' })
}

/**
 * The single `location` a redirect names, or a failure if it names two different ones.
 *
 * Next 16.3.5 emits `location` **twice** on a redirect produced by an on-demand static render — the same
 * value both times, which `Headers#get` returns joined by a comma. A browser takes the first and it is
 * harmless, but the assertion cannot be `toBe(target)` on the raw header, and it must not be a `toContain`
 * either: two *different* locations would be a genuine defect and `toContain` would pass on one of them. So
 * every value is compared, and the one they agree on is returned.
 */
function locationOf(response: Response): string | null {
  const header = response.headers.get('location')
  if (header === null) return null
  const values = [...new Set(header.split(',').map((value) => value.trim()))]
  expect(values, `two different locations on one redirect: ${header}`).toHaveLength(1)
  return values[0] ?? null
}

async function fetchHtml(path: string): Promise<string> {
  const response = await fetchPath(path)
  expect(response.status, `${path} did not answer 200`).toBe(200)
  return await response.text()
}

/** Every JSON-LD block in a document, parsed. */
function jsonLdBlocks(html: string): readonly unknown[] {
  const blocks: unknown[] = []
  const pattern = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g
  let match = pattern.exec(html)
  while (match !== null) {
    blocks.push(JSON.parse(match[1] ?? 'null') as unknown)
    match = pattern.exec(html)
  }
  return blocks
}

interface GraphNode {
  readonly '@type': unknown
  readonly name?: unknown
  readonly offers?: unknown
  readonly url?: unknown
}

const nodesOf = (graph: unknown): readonly GraphNode[] =>
  ((graph as { '@graph'?: GraphNode[] })['@graph'] ?? []) as readonly GraphNode[]

const typeOf = (node: GraphNode): string => JSON.stringify(node['@type'])

/** The price cell the served DOM holds for one catalogue row, or undefined. */
function priceCell(html: string, id: string): string | undefined {
  const pattern = new RegExp(`data-price-row="${id}"[^>]*>([^<]*)<`)
  return pattern.exec(html)?.[1]
}

/**
 * Every `<h2>` in a document, with its id and the tag that immediately follows it.
 *
 * A regex over the served markup rather than a DOM: the claim is *"immediately followed by a `<p>`"*, and a
 * DOM parser normalises exactly what would be wrong — an unclosed heading, a wrapper element, whitespace
 * that is a text node. What went over the wire is the thing to assert.
 */
function headings(html: string): readonly { id: string; text: string; next: string }[] {
  const found: { id: string; text: string; next: string }[] = []
  const pattern = /<h2([^>]*)>([\s\S]*?)<\/h2>([\s\S]{0,40})/g
  let match = pattern.exec(html)
  while (match !== null) {
    const attributes = match[1] ?? ''
    const id = /id="([^"]*)"/.exec(attributes)?.[1] ?? ''
    const next = /^\s*<([a-zA-Z][a-zA-Z0-9]*)/.exec(match[3] ?? '')?.[1] ?? ''
    found.push({ id, text: (match[2] ?? '').replace(/<[^>]*>/g, '').trim(), next })
    match = pattern.exec(html)
  }
  return found
}

/**
 * One publish-loop run, as the admin would trigger it.
 *
 * Used for three things: warming the menu pages before anything is asserted, the loop's own test, and
 * **restoring** those pages after a probe service is deleted. The restore matters beyond this file: `.next`
 * holds the ISR cache on disk, so a `/pricing` regenerated while a probe was published is the copy the next
 * run's server serves — and `structured-data.itest.ts` compares that copy, byte for byte, against a graph
 * built from the catalogue as it is then. A probe this file created must not outlive it in a cache.
 */
async function revalidateFor(body: Record<string, unknown>): Promise<Response> {
  return await fetch(`${BASE}/settings/catalogue/revalidate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * Regenerates the menu pages from the catalogue as it stands now, and **fetches them**.
 *
 * The fetch is the half that matters, and it cost a verify run to find. `revalidatePath` marks the cache
 * entry stale rather than deleting it: with no request afterwards the stale copy stays on disk, and the next
 * process to ask for the page is served that copy once before the regeneration lands. So a run that created a
 * probe, revalidated and exited left `/pricing` listing a service that no longer existed — and
 * `structured-data.itest.ts`, which runs before this file and compares the served block byte for byte against
 * a graph built from the catalogue, failed on a page this file had polluted.
 *
 * Twice per path: the first request triggers the regeneration, the second is served the fresh copy, so the
 * entry left on disk is the one a clean build would have produced.
 */
async function restoreMenuPages(): Promise<void> {
  const first = facts.catalogue.services[0]?.slug
  if (first === undefined) return
  const response = await revalidateFor({ kind: 'price', slug: first })
  expect(response.status, 'the menu pages could not be restored').toBe(200)
  for (const path of ['/treatments', '/pricing', '/ar/treatments', '/ar/pricing']) {
    await fetchPath(path)
    await fetchPath(path)
  }
}

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
  await seedPremises(sql)
  await ensureLegalEntity(sql)
  const seeded = await readCompliancePolicy(sql)
  policy = {
    bannedClaimTerms: seeded.bannedClaimTerms,
    permittedPublicTitles: seeded.permittedPublicTitles,
    medicalClaimsPermitted: seeded.medicalClaimsPermitted,
  }
  await seedCatalogue(sql, { lint: (name) => assertPublicDisplayNameCompliant(name, policy) })

  const read = await readPremisesFacts(sql)
  if (read === null) throw new Error('premises has no row: the migrations have not been applied')
  facts = buildFacts(read, { generatedAt: '2026-01-01T00:00:00.000Z', origin: siteOrigin() })
  licenceClass = seeded.licenceClass

  server = await startWebServer({
    suite: 'treatments',
    cwd: new URL('..', import.meta.url).pathname,
    probePath: '/treatments',
    readyWithinMs: 90_000,
  })
  BASE = server.origin

  /*
    The menu pages are revalidated before anything is asserted, and the reason is a trap worth recording.

    `.next` holds the ISR cache **on disk**, so a page this suite revalidated in an earlier run is served from
    that cache by the next run's server — with whatever catalogue existed at the moment it was regenerated,
    including the probe services this file creates and deletes. The first run passed and the second reported
    nine services on `/pricing`.

    So the loop is used for what it is for: one POST, and the index and both locales of `/pricing` are built
    from the catalogue as it is now. It is also a second, incidental proof that the endpoint works before any
    test depends on it.
  */
  await restoreMenuPages()
}, 180_000)

afterAll(async () => {
  await server?.stop()
  await sql?.end({ timeout: 5 })
})

describe('acceptance — every (style x treatment) service has an indexable route returning 200', () => {
  it('answers 200 on all eight treatment routes, in both locales', async () => {
    // Eight, from the catalogue. Stated as the catalogue's own count rather than as the literal 8, with the
    // literal asserted once: a fixture that lost a service would otherwise make this pass over seven pages.
    expect(facts.catalogue.services).toHaveLength(8)
    for (const service of facts.catalogue.services) {
      for (const locale of ['en', 'ar'] as const) {
        const path = localisedPath(servicePath(service.slug), locale)
        const html = await fetchHtml(path)
        expect(html, path).toContain(service.name)
        // Indexable: the registry declares it, and the absence of the header is what "indexable" means on
        // the wire. `route-spine.itest.ts` asserts the header's presence on the admin routes.
        const response = await fetchPath(path)
        expect(response.headers.get('x-robots-tag'), path).toBeNull()
      }
    }
  }, 120_000)

  it('lists exactly eight treatment routes in the sitemap, one per published service', async () => {
    const entries = await treatmentSitemapEntries(sql)
    const slugs = [...new Set(entries.map((entry) => entry.slug))]
    expect(slugs).toHaveLength(8)
    expect([...slugs].sort()).toEqual([...facts.catalogue.services.map((s) => s.slug)].sort())
    // Two documents per route, exactly as `/` and `/ar` are one route and two entries.
    expect(entries).toHaveLength(16)
    for (const entry of entries) {
      expect(entry.path, entry.path).not.toContain('[')
      // A lastmod a crawler can trust: an ISO instant from the rows, not the time of this run.
      expect(entry.lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect((await fetchPath(entry.path)).status, entry.path).toBe(200)
    }
  }, 120_000)

  it('renders exactly 32 price rows across the eight pages, each equal to its catalogue row', async () => {
    // The acceptance criterion's other number, and the assertion is per row rather than a total: a page that
    // rendered one figure thirty-two times would satisfy a count.
    let rendered = 0
    for (const service of facts.catalogue.services) {
      const html = await fetchHtml(servicePath(service.slug))
      // Durations are ROWS, not routes. Four rows on one page, never four pages.
      expect(service.variants).toHaveLength(4)
      for (const variant of service.variants) {
        const id = priceRowId(service.slug, variant.durationMinutes)
        const cell = priceCell(html, id)
        expect(cell, `${id} is not rendered on ${servicePath(service.slug)}`).toBeDefined()
        expect(cell, id).toBe(formatAmount(grossMoneyFromFils(variant.grossFils)))
        expect(cell, id).toBe(priceCellFor(variant))
        rendered += 1
      }
      // And no row belonging to another treatment: this page is about one.
      for (const other of facts.catalogue.services) {
        if (other.slug === service.slug) continue
        const otherId = priceRowId(other.slug, other.variants[0]?.durationMinutes ?? 0)
        expect(priceCell(html, otherId), `${otherId} on ${service.slug}`).toBeUndefined()
      }
    }
    expect(rendered).toBe(32)
    expect(rendered).toBe(facts.catalogue.pricePointCount)
  }, 120_000)

  it('renders all 32 rows on /pricing, in both locales, with the same figures', async () => {
    for (const locale of ['en', 'ar'] as const) {
      const html = await fetchHtml(localisedPath('/pricing', locale))
      let counted = 0
      for (const service of facts.catalogue.services) {
        for (const variant of service.variants) {
          const id = priceRowId(service.slug, variant.durationMinutes)
          expect(priceCell(html, id), `${id} (${locale})`).toBe(priceCellFor(variant))
          counted += 1
        }
      }
      expect(counted, locale).toBe(32)
    }
  }, 60_000)
})

describe('acceptance — every h2 is question-shaped, anchored, and followed by a paragraph', () => {
  it('holds for all eight treatment pages in both locales', async () => {
    const ids = [...TREATMENT_QUESTIONS]
    for (const service of facts.catalogue.services) {
      for (const locale of ['en', 'ar'] as const) {
        const path = localisedPath(servicePath(service.slug), locale)
        const html = await fetchHtml(path)
        const found = headings(html)
        expect(
          found.map((heading) => heading.id),
          path,
        ).toEqual(ids)
        for (const heading of found) {
          // Question-shaped, in either script.
          expect(heading.text, `${path} ${heading.id}`).toMatch(/[?؟]$/)
          // A stable slugified id.
          expect(heading.id, path).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
          // Immediately followed by a <p>. The structural half of the criterion: nothing — not a wrapper,
          // not an image, not a rule — may sit between the question and its answer.
          expect(heading.next, `${path} ${heading.id} is followed by <${heading.next}>`).toBe('p')
        }
      }
    }
  }, 120_000)

  it('anchors the same headings in both locales, so a citation survives the language', async () => {
    const english = headings(await fetchHtml(servicePath(facts.catalogue.services[0]?.slug ?? '')))
    const arabic = headings(
      await fetchHtml(localisedPath(servicePath(facts.catalogue.services[0]?.slug ?? ''), 'ar')),
    )
    expect(arabic.map((heading) => heading.id)).toEqual(english.map((heading) => heading.id))
    // The control: the questions themselves are translated, or this is one document served twice.
    expect(arabic.map((heading) => heading.text)).not.toEqual(
      english.map((heading) => heading.text),
    )
  }, 60_000)

  it('detects a heading that is not followed by a paragraph', () => {
    // The control on the parser. Without it, a regex that stopped matching would report zero headings and
    // every assertion above would pass on an empty list.
    const good = '<h2 id="how-much-does-it-cost">How much?</h2><p>From 250.00.</p>'
    const bad = '<h2 id="how-much-does-it-cost">How much?</h2><div>From 250.00.</div>'
    expect(headings(good)[0]?.next).toBe('p')
    expect(headings(bad)[0]?.next).toBe('div')
    expect(headings(good)[0]?.text).toBe('How much?')
    expect(headings('<p>no headings here</p>')).toEqual([])
  })
})

describe('acceptance — the Offer JSON-LD describes this treatment, from the catalogue', () => {
  it('publishes one Service with its four priced Offers, and validates', async () => {
    const service = facts.catalogue.services[0]
    expect(service).toBeDefined()
    if (service === undefined) return
    const blocks = jsonLdBlocks(await fetchHtml(servicePath(service.slug)))
    expect(blocks).toHaveLength(1)
    const graph = blocks[0]
    const findings = validateGraph(graph, {
      licence: licenceClass as never,
      requireTypes: ['DaySpa', 'Organization', 'Service', 'BreadcrumbList'],
    })
    expect(formatFindings(findings)).toBe('')

    const services = nodesOf(graph).filter((node) => typeOf(node).includes('Service'))
    expect(services).toHaveLength(1)
    expect(services[0]?.name).toBe(service.name)
    // The Service links to its own page, which is the hook W-SITE-03 left for this unit.
    expect(services[0]?.url).toBe(`${siteOrigin()}${servicePath(service.slug)}`)
    const offers = (services[0]?.offers ?? []) as { price?: string; priceCurrency?: string }[]
    expect(offers).toHaveLength(4)
    for (const offer of offers) {
      expect(offer.priceCurrency).toBe('AED')
      expect(offer.price).toMatch(/^\d+\.\d{2}$/)
    }
    // Every Offer price is a catalogue row, and every catalogue row is an Offer price.
    expect([...offers.map((offer) => offer.price)].sort()).toEqual(
      [...service.variants.map((variant) => variant.grossAed)].sort(),
    )
  }, 60_000)

  it('publishes the whole menu on /pricing and the index, because the menu is their subject', async () => {
    for (const path of ['/pricing', '/treatments']) {
      const graph = jsonLdBlocks(await fetchHtml(path))[0]
      const services = nodesOf(graph).filter((node) => typeOf(node).includes('Service'))
      // Eight catalogue services plus the three price-on-request offerings, which belong to the menu and to
      // no treatment page.
      expect(services.length, path).toBe(
        facts.catalogue.services.length + facts.catalogue.onRequest.length,
      )
      expect(formatFindings(validateGraph(graph, { licence: licenceClass as never })), path).toBe(
        '',
      )
    }
  }, 60_000)
})

describe('acceptance — the three price-on-request offerings publish no figure', () => {
  it('renders "Price on request" on /pricing and nowhere a number', async () => {
    const html = await fetchHtml('/pricing')
    expect(facts.catalogue.onRequest).toHaveLength(3)
    for (const offering of facts.catalogue.onRequest) {
      expect(html, offering.label).toContain(offering.label)
      // The derived 1.8x figure B-CAT-06 reversed must not exist anywhere: the table has no price column
      // (0032) and the open question is unanswered.
      expect(html).not.toContain(`${offering.label}</strong>: 1`)
    }
    expect(html).toContain('Price on request')
    const graph = jsonLdBlocks(html)[0]
    const onRequestNodes = nodesOf(graph).filter((node) =>
      facts.catalogue.onRequest.some((offering) => offering.label === node.name),
    )
    expect(onRequestNodes).toHaveLength(3)
    for (const node of onRequestNodes) {
      const offers = (node.offers ?? []) as Record<string, unknown>[]
      expect(offers).toHaveLength(1)
      // No price and no currency: an Offer with a currency and no figure reads as free, and the validator
      // refuses it. The words are what carries the meaning.
      expect(offers[0]?.['price']).toBeUndefined()
      expect(offers[0]?.['priceCurrency']).toBeUndefined()
      expect(String(offers[0]?.['description'])).toMatch(/Price on request/)
    }
  }, 60_000)

  it('returns all three from the Unconfirmed Assumptions query', async () => {
    const rows = await unconfirmedAssumptionRows(sql)
    const labels = rows
      .filter((row) => row.source === 'price_on_request')
      .map((row) => row.reference)
    for (const offering of facts.catalogue.onRequest) {
      expect(labels, offering.label).toContain(offering.label)
      expect(offering.provisional).toBe(true)
      expect(offering.openQuestionId).toBe('Y9-poa-prices')
    }
  })
})

/**
 * The redirect half, and the guard rails B-CAT-05 owns.
 *
 * A probe service of its own: renaming or archiving a seeded treatment would leave the shared database with a
 * changed menu for every file that runs after this one (brief rule 12). It is created published — a rename is
 * only meaningful on a page that answers — and deleted in `afterAll`.
 */
describe('acceptance — a slug change 301s in one hop, an archived treatment leaves the sitemap', () => {
  /*
    A per-run identity, for the same disk-cache reason the warm-up above records: a probe slug reused between
    runs is served from the previous run's ISR entry — a cached 308 for a path this run has just published,
    which is a false failure that looks exactly like a broken redirect.
  */
  const RUN = Date.now().toString(36)
  const PROBE = `wsite05_probe_${RUN}`
  const PROBE_SLUG = `wsite05-probe-${RUN}`
  let serviceId: string
  let variantId: string

  const revalidate = revalidateFor

  beforeAll(async () => {
    await cleanProbe()
    const [service] = await sql<{ id: string }[]>`
      insert into service
        (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes)
      values ('asian', ${PROBE}, ${`${PROBE_SLUG}-old`}, 'Probe', ${'Hot Oil / Balm Massage (Asian)'}, 20)
      returning id
    `
    serviceId = service?.id as string
    await sql`
      insert into service_room_type_compat (service_style, service_treatment_key, room_type)
      values ('asian', ${PROBE}, 'standard')
    `
    await sql`
      insert into service_resource_shape
        (service_style, service_treatment_key, shape, therapists_required, rooms_required,
         min_room_capacity, required_room_type, therapist_buffer_minutes)
      values ('asian', ${PROBE}, 'solo', 1, 1, 1, 'standard', 10)
    `
    const [variant] = await sql<{ id: string }[]>`
      insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
      values (${serviceId}, 60, 20000, ${'W-SITE-05 probe fixture'})
      returning id
    `
    variantId = variant?.id as string
    await sql`update service set published_at = now() where id = ${serviceId}`
  })

  afterAll(async () => {
    await cleanProbe()
    // The probe appeared in the menu pages while it was published, and this run revalidated them. Put them
    // back, or the next run's server serves a `/pricing` listing a service that no longer exists.
    await restoreMenuPages()
  })

  /** Removes this run's probe **and** anything an interrupted earlier run left behind. */
  async function cleanProbe(): Promise<void> {
    await sql`delete from redirect_map where source_path like ${'/treatments/wsite05-probe-%'}`
    await sql`delete from redirect_map where target_path like ${'/treatments/wsite05-probe-%'}`
    await sql`delete from service where treatment_key like ${'wsite05_probe%'}`
    await sql`delete from service_room_type_compat where service_treatment_key like ${'wsite05_probe%'}`
  }

  it('serves a published treatment that was not prerendered, then 301s its retired path in one hop', async () => {
    const oldPath = servicePath(`${PROBE_SLUG}-old`)
    const newPath = servicePath(`${PROBE_SLUG}-new`)
    // Rendered on demand: `dynamicParams` is left at its default, which is what makes a treatment published
    // after the build reachable immediately rather than 404 until the next deploy.
    expect((await fetchPath(oldPath)).status).toBe(200)

    await withUnitOfWork(sql, ACTOR, (uow) =>
      renameServiceSlug(uow, { serviceId, slug: `${PROBE_SLUG}-new` }),
    )
    // The rename is a catalogue change, so the publish loop runs: without it the cached copy of the old path
    // goes on answering 200 with the old name, which is the rename silently not happening.
    const report = await revalidate({
      kind: 'slug',
      slug: `${PROBE_SLUG}-new`,
      previousSlug: `${PROBE_SLUG}-old`,
    })
    expect(report.status).toBe(200)

    const moved = await fetchPath(oldPath)
    // One PERMANENT hop. 308 rather than 301 because Next's `redirect()` is a 307 — temporary — and 0029
    // refuses a temporary redirect for a permanent rename in so many words. The stored row says 301; the two
    // are the same signal to every search engine. See the page's header.
    expect([301, 308]).toContain(moved.status)
    expect(locationOf(moved)).toBe(newPath)
    // The half that makes the redirect worth having: what it points at answers 200, with no second hop.
    const landed = await fetchPath(newPath)
    expect(landed.status).toBe(200)
    expect(locationOf(landed)).toBeNull()
  }, 60_000)

  it('redirects a retired path that carries a campaign parameter, dropping the query', async () => {
    /*
      The behaviour, asserted as it is rather than as it should be.

      B-CAT-05's handler carried the query across, and this page cannot: `searchParams` is a dynamic API and
      a route with `generateStaticParams` renders an unlisted param as a *static* render at request time, so
      the redirect branch fails with `DYNAMIC_SERVER_USAGE` and answers 500. That was measured, not assumed.
      Prerendering the eight pages is the acceptance criterion; the attribution loss on a redirect from a
      retired slug is the cost, and the page's header records where the fix belongs (the proxy or a CDN rule
      over `redirect_map`, which W-SITE-09 owns).

      This assertion fails the day the query survives, which is the point: it is a deferral with a tripwire,
      not a silent regression.
    */
    const moved = await fetchPath(`${servicePath(`${PROBE_SLUG}-old`)}?utm_source=google`)
    expect([301, 308]).toContain(moved.status)
    expect(locationOf(moved)).toBe(servicePath(`${PROBE_SLUG}-new`))
  }, 30_000)

  it('404s a slug that never existed, rather than redirecting it to the index', async () => {
    // The control that keeps every redirect above meaningful, and a decision: a 301 from every mistyped URL
    // to `/treatments` tells a crawler those URLs are pages that moved.
    expect((await fetchPath('/treatments/wsite05-never-existed')).status).toBe(404)
  }, 30_000)

  it('sends an archived treatment to the index and removes it from the sitemap', async () => {
    const path = servicePath(`${PROBE_SLUG}-new`)
    const before = await treatmentSitemapEntries(sql)
    expect(before.map((entry) => entry.slug)).toContain(`${PROBE_SLUG}-new`)

    const archived = await withUnitOfWork(sql, ACTOR, (uow) => archiveService(uow, { serviceId }))
    expect(archived.redirect).toEqual({ sourcePath: path, targetPath: TREATMENTS_INDEX_PATH })
    await revalidate({ kind: 'archive', slug: `${PROBE_SLUG}-new` })

    const gone = await fetchPath(path)
    expect([301, 308]).toContain(gone.status)
    expect(locationOf(gone)).toBe(TREATMENTS_INDEX_PATH)
    expect((await fetchPath(TREATMENTS_INDEX_PATH)).status).toBe(200)
    // A delta, not a total: the shared database holds whatever earlier files left behind (brief rule 9).
    const after = await treatmentSitemapEntries(sql)
    expect(after.map((entry) => entry.slug)).not.toContain(`${PROBE_SLUG}-new`)
    expect(before.length - after.length).toBe(2)
  }, 60_000)

  it('refuses to delete a treatment with a future booking, by name', async () => {
    /*
      B-CAT-05's guard, asserted by its refusal **name** rather than by a second check of my own — the brief's
      instruction and the right one: the mechanism is `appointment.service_variant_id` ON DELETE RESTRICT
      (0024) translated by `catalogueError`, and a second implementation here would be a check that could
      disagree with the one that runs.

      Why it matters to a *route*: the page for a treatment somebody has booked must not be able to disappear.
      The guest's confirmation links to it, and the appointment holds a snapshotted price whose provenance is
      that page.

      The appointment is built the way `catalogue-compliance.itest.ts` builds one — a `business_day`, a
      customer, a booking, a real room — on a far-future trading date, and torn down in the same test.
      `therapist_id` has no foreign key (there is no `employee` row in this database: the roster loader is
      B-AVAIL's and is not wired), so it is a literal UUID and nothing about the person is invented.
    */
    const tradingDate = '2099-07-01'
    const at = (hour: string): string => `2099-07-01 ${hour}:00:00+00`
    const phone = '+971500000205'
    const therapist = 'aaaaaaaa-0000-4000-8000-0000000c0511'
    const [room] = await sql<{ id: string }[]>`select id from rooms where code = 'room-1'`
    expect(room?.id).toBeDefined()
    const [customer] = await sql<{ id: string }[]>`
      insert into customer (phone_e164, created_via) values (${phone}, 'guest_booking')
      on conflict (phone_e164) do update set created_via = excluded.created_via
      returning id
    `
    await sql`
      insert into business_day (trading_date, opens_at, closes_at, source)
      values (${tradingDate}, ${at('07')}::timestamptz, ${at('22')}::timestamptz, 'weekly')
      on conflict (trading_date) do nothing
    `
    const [booking] = await sql<{ id: string }[]>`
      insert into booking (customer_id, source) values (${customer?.id as string}, 'online')
      returning id
    `
    await sql`
      insert into appointment
        (booking_id, trading_date, service_variant_id, shape, therapist_id, room_id, period, status,
         turnaround_minutes, therapist_buffer_minutes, gross_price_fils, net_fils, vat_fils)
      values (
        ${booking?.id as string}, ${tradingDate}, ${variantId}, 'solo', ${therapist},
        ${room?.id as string}, ${`[${at('20')},${at('21')})`}::tstzrange, 'confirmed', 20, 10,
        20000, 19048, 952
      )
    `
    try {
      const failure = await withUnitOfWork(sql, ACTOR, (uow) =>
        deleteService(uow, serviceId),
      ).catch((err: unknown) => err)
      expect(refusalOf(failure)).toBe('service_has_appointments')
      // The control: the service is still there, so the refusal left the row alone rather than half-deleting
      // it — and the page it serves still answers.
      const [survivor] = await sql<{ id: string }[]>`select id from service where id = ${serviceId}`
      expect(survivor?.id).toBe(serviceId)
    } finally {
      await sql`delete from booking where id = ${booking?.id as string}`
      await sql`delete from business_day where trading_date = ${tradingDate}`
      await sql`delete from customer where phone_e164 = ${phone}`
    }
  }, 60_000)
})

/**
 * The publish loop, end to end: one price change, one job run, five artefacts.
 *
 * The price is changed through `changeVariantPrice` — the admin path, which inserts an effective-dated
 * `price_list` row and never overwrites the catalogue figure — on a **probe** service, so the seeded menu
 * every other file reads is untouched, and the row is deleted afterwards.
 */
describe('acceptance — one job run changes the treatment page, the index, /pricing, the Offer and the lastmod', () => {
  /** A per-run identity, for the disk-cache reason the suite's `beforeAll` records. */
  const RUN = Date.now().toString(36)
  const PROBE = `wsite05_loop_${RUN}`
  const SLUG = `wsite05-loop-${RUN}`
  let serviceId: string
  let variantId: string

  beforeAll(async () => {
    await cleanLoopProbe()
    const [service] = await sql<{ id: string }[]>`
      insert into service
        (style, treatment_key, slug, internal_name, public_display_name, turnaround_minutes)
      values ('arabic', ${PROBE}, ${SLUG}, 'Loop probe', ${'Normal Massage (Arabic)'}, 20)
      returning id
    `
    serviceId = service?.id as string
    await sql`
      insert into service_room_type_compat (service_style, service_treatment_key, room_type)
      values ('arabic', ${PROBE}, 'standard')
    `
    await sql`
      insert into service_resource_shape
        (service_style, service_treatment_key, shape, therapists_required, rooms_required,
         min_room_capacity, required_room_type, therapist_buffer_minutes)
      values ('arabic', ${PROBE}, 'solo', 1, 1, 1, 'standard', 10)
    `
    const [variant] = await sql<{ id: string }[]>`
      insert into service_variant (service_id, duration_minutes, gross_price_fils, provisional_note)
      values (${serviceId}, 90, 30000, ${'W-SITE-05 publish-loop fixture'})
      returning id
    `
    variantId = variant?.id as string
    await sql`update service set published_at = now() where id = ${serviceId}`
  })

  afterAll(async () => {
    await cleanLoopProbe()
    await restoreMenuPages()
  })

  async function cleanLoopProbe(): Promise<void> {
    await sql`delete from redirect_map where source_path like ${'/treatments/wsite05-loop-%'}`
    await sql`delete from service where treatment_key like ${'wsite05_loop%'}`
    await sql`delete from service_room_type_compat where service_treatment_key like ${'wsite05_loop%'}`
  }

  it('moves all five artefacts, and four out of five is a failure', async () => {
    const path = servicePath(SLUG)
    // Warm every artefact so the cached copy is the one a visitor would be served.
    const beforeTreatment = await fetchHtml(path)
    const beforeIndex = await fetchHtml('/treatments')
    const beforePricing = await fetchHtml('/pricing')
    const beforeOffer = JSON.stringify(jsonLdBlocks(beforeTreatment)[0])
    const beforeLastmod = (await treatmentSitemapEntries(sql)).find(
      (entry) => entry.slug === SLUG,
    )?.lastModified
    expect(beforeIndex).toContain('Normal Massage (Arabic)')
    expect(beforeTreatment).toContain(formatAmount(grossMoneyFromFils('30000')))
    expect(beforeLastmod).toBeDefined()

    // The admin path: an effective-dated price_list row, in force today, which is what a price rise is.
    const raised = 34_500
    await withUnitOfWork(sql, ACTOR, (uow) =>
      changeVariantPrice(uow, {
        serviceVariantId: variantId,
        grossPriceFils: raised,
        label: 'W-SITE-05 publish loop',
        validFrom: new Date().toISOString().slice(0, 10),
        validTo: null,
      }),
    )

    // Nothing has changed on the site yet, and that is the point of the loop: a prerendered page does not
    // notice a row. This is the assertion that makes the rest of the test non-vacuous.
    expect(await fetchHtml(path), 'the cached page changed without a revalidation').toBe(
      beforeTreatment,
    )

    const response = await fetch(`${BASE}/settings/catalogue/revalidate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'price', slug: SLUG }),
    })
    expect(response.status).toBe(200)
    const report = (await response.json()) as {
      paths: string[]
      artefacts: string[]
    }
    // One run, and it names every artefact it claims to have moved.
    expect([...report.artefacts].sort()).toEqual([...CATALOGUE_ARTEFACTS].sort())
    expect([...report.paths].sort()).toEqual(
      [...revalidationPathsFor({ kind: 'price', slug: SLUG })].sort(),
    )

    const afterTreatment = await fetchHtml(path)
    const afterIndex = await fetchHtml('/treatments')
    const afterPricing = await fetchHtml('/pricing')
    const afterOffer = JSON.stringify(jsonLdBlocks(afterTreatment)[0])
    const afterLastmod = (await treatmentSitemapEntries(sql)).find(
      (entry) => entry.slug === SLUG,
    )?.lastModified

    const expected = formatAmount(grossMoneyFromFils(String(raised)))
    // 1. the treatment page
    expect(afterTreatment).not.toBe(beforeTreatment)
    expect(priceCell(afterTreatment, priceRowId(SLUG, 90))).toBe(expected)
    // 2. the index — it changed because the menu it lists is read at revalidation, not at build
    expect(afterIndex).not.toBe(beforeIndex)
    // 3. /pricing
    expect(afterPricing).not.toBe(beforePricing)
    expect(priceCell(afterPricing, priceRowId(SLUG, 90))).toBe(expected)
    // 4. the Offer JSON-LD, inside the treatment page
    expect(afterOffer).not.toBe(beforeOffer)
    expect(afterOffer).toContain(`"price":"${(raised / 100).toFixed(2)}"`)
    // 5. the sitemap's lastmod
    expect(afterLastmod).toBeDefined()
    expect(afterLastmod).not.toBe(beforeLastmod)
  }, 180_000)

  it('renders the price the till would charge, not the catalogue fallback', async () => {
    // The defect this unit found: `changeVariantPrice` writes a `price_list` row and deliberately never
    // updates `service_variant`, and every published surface read the variant — so a raised price was
    // published nowhere and charged everywhere. The row is still in force from the test above.
    const [row] = await sql<{ gross_price_fils: string }[]>`
      select gross_price_fils from service_variant where id = ${variantId}
    `
    const read = await readPremisesFacts(sql)
    const published = read?.prices.find(
      (price) => price.slug === SLUG && price.durationMinutes === 90,
    )
    expect(published?.grossPriceFils).not.toBe(row?.gross_price_fils)
    expect(published?.grossPriceFils).toBe('34500')
    expect(await fetchHtml(servicePath(SLUG))).toContain(
      formatMoney(grossMoneyFromFils('34500'), 'en'),
    )
  }, 60_000)
})

describe('acceptance — the sample slug the registry publishes is a real treatment', () => {
  it('resolves to a published service', async () => {
    // The registry carries one catalogue value — the slug the screenshot harness and the spine tests visit
    // the treatment route with. If a rename made it stale, every one of those would be photographing a
    // redirect and nothing would say so.
    const { sampleParamsOf, routeById } = await import('./routes/registry.ts')
    const slug = sampleParamsOf(routeById('treatment'))['slug']
    expect(slug).toBeDefined()
    expect(facts.catalogue.services.map((service) => service.slug)).toContain(slug)
    expect((await fetchPath(servicePath(slug as string))).status).toBe(200)
  }, 30_000)
})
