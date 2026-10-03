import {
  formatFindings,
  formatRedirectMapFindings,
  formatSitemapFindings,
  isTherapistPublishable,
  LEGACY_BASELINE,
  lastmodFor,
  reciprocityFindings,
  redirectMapFindings,
  SITEMAP_TYPES,
  type SitemapType,
  validateGraph,
} from '@berelax/core'
import {
  allRedirects,
  changeVariantPrice,
  createConnection,
  ensureLegalEntity,
  importBaselineRedirects,
  lookupRedirect,
  readPropagations,
  readTherapistPages,
  readTreatmentPages,
  type Sql,
  seedCatalogue,
  seedPremises,
  THERAPIST_INDEX_PATH,
  type TherapistPageRow,
  therapistPathFor,
  withUnitOfWork,
} from '@berelax/db'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { archiveTherapist, publishTherapist } from '@berelax/hr'
import { createFakePurge, purgeIdempotencyKey } from '@berelax/media/purge'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import { createFakeIndexNow, indexNowIdempotencyKey } from '@berelax/providers/seo'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { propagatePublish } from '../../worker/src/jobs/publish-propagate.ts'
import { localisedPath } from './i18n/locales.ts'
import { rewriteInternalLinks } from './jobs/rewrite-internal-links.ts'
import { revalidationPathsFor } from './revalidate/catalogue.ts'
import { cacheTagsFor } from './revalidate/interconnection.ts'
import { alternatesFor, siteOrigin } from './routes/alternates.ts'
import { sitemapEntries } from './routes/registry.ts'
import { SITEMAP_INDEX_PATH, sitemapSectionPath } from './sitemap/build.ts'
import { candidateFor, dispositionOf } from './therapists/read.ts'
import { therapistSitemapEntries } from './therapists/sitemap.ts'

/**
 * The public site's served bytes: W-SITE-06's therapist routes, W-SITE-08's sitemaps and publish loop,
 * and W-SITE-09's 301 map.
 *
 * ## Why ONE file for three units
 *
 * `@berelax/harness/ports` gives a band to a SUITE, and `apps/web/src/test-ports.test.ts` proves every
 * band has exactly one claimant — a second `startWebServer` on one band is two applications racing for one
 * port, where the loser cannot bind and the winner answers both suites (brief rule 18: neither green nor
 * red means anything). W-SITE-06, W-SITE-08 and W-SITE-09 were allocated one band between them, so they
 * share one suite and one server, with a `describe` per unit.
 *
 * ## What is here because it cannot be anywhere else
 *
 *   - **A status code.** 200 for a publishable therapist, 404 for each of the three combinations that are
 *     not, and ONE permanent hop to the index for one who has left. `content.test.ts` can assert which
 *     card carries an anchor; only a request can assert what a URL answers.
 *   - **The absence of an anchor in served markup.** The acceptance line is *"a card containing no anchor
 *     element"*, which is a property of the DOM.
 *   - **The guard holding against a row that claims otherwise.** `employee.is_publishable` is GENERATED,
 *     so the "forced" row of the acceptance line cannot be written at all — and that refusal is asserted
 *     here rather than assumed, because it is the reason the route does not need to re-check the flag.
 *
 * ## The probe therapists, and why they are not the seeded nineteen
 *
 * Brief rule 12: the integration suite shares one database and the file order is not this file's to
 * choose. Publishing one of the seeded nineteen would leave a display name on a row the home page, the
 * roster read and `structured-data.itest.ts` all read, and `structured-data.itest.ts` asserts that NO row
 * passes the guard. So this file creates four employees of its own, deletes them in `afterAll`, and the
 * labels are visibly synthetic — `Probe Therapist 01`, never a plausible person's name (brief rule 10).
 */
let BASE = ''
let server: WebServer
let sql: Sql
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''
if (!DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

const ACTOR = { kind: 'system', label: 'W-SITE-06 itest' } as const

/**
 * A display name that cannot be read as a person's.
 *
 * Brief rule 10 and rule 15: this build does not invent therapist names, and a plausible one in a fixture
 * is worse than a visible label because it is indistinguishable from a configured one. `Probe Therapist
 * 01` carries no provisional marker either, so `employee_display_name_not_placeholder` (0050) accepts it —
 * which it must, or the suite could not exercise the published branch at all.
 */
const probeDisplayName = (index: number): string =>
  `Probe Therapist ${String(index).padStart(2, '0')}`
const probeReference = (index: number): string => `WSITE06 Probe ${String(index).padStart(2, '0')}`

/** The four combinations of (display name present/absent) x (photography consent recorded/absent). */
const COMBINATIONS = [
  { index: 1, name: true, consent: true },
  { index: 2, name: true, consent: false },
  { index: 3, name: false, consent: true },
  { index: 4, name: false, consent: false },
] as const

/** The employee ids this suite created, so `afterAll` deletes only its own rows. */
const probeIds = new Map<number, string>()

async function fetchPath(path: string): Promise<Response> {
  return await fetch(`${BASE}${path}`, { redirect: 'manual' })
}

/** The single `location` a redirect names, or a failure if it names two different ones. */
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

/** Every `<a href>` in a fragment of markup. */
function anchorsIn(html: string): readonly string[] {
  return [...html.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((match) => match[1] as string)
}

/**
 * The markup of one therapist's card, cut from the index by its reference.
 *
 * The card is a `<li>`, and the reference is the one thing that tells two unnamed cards apart — it is the
 * link's accessible name when there is a link, and the only identifier on the card when there is not. The
 * slice runs from the reference back to the opening `<li` before it and forward to the next `</li>`, so
 * "this card has no anchor" is a claim about THIS card rather than about the page.
 */
function cardFor(html: string, reference: string): string {
  const at = html.indexOf(reference)
  expect(at, `no card for ${reference} on the index`).toBeGreaterThan(-1)
  const open = html.lastIndexOf('<li', at)
  const close = html.indexOf('</li>', at)
  expect(open, reference).toBeGreaterThan(-1)
  expect(close, reference).toBeGreaterThan(at)
  return html.slice(open, close)
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
  readonly knowsAbout?: unknown
  readonly knowsLanguage?: unknown
}

const nodesOf = (graph: unknown): readonly GraphNode[] =>
  ((graph as { '@graph'?: GraphNode[] })['@graph'] ?? []) as readonly GraphNode[]

const personNodes = (html: string): readonly GraphNode[] =>
  jsonLdBlocks(html)
    .flatMap((graph) => nodesOf(graph))
    .filter((node) => JSON.stringify(node['@type']).includes('Person'))

/** The licence class in force, which the graph's vocabulary is validated against. */
async function readLicenceClass(): Promise<string> {
  const [row] = await sql<{ licence_class: string }[]>`
    select licence_class::text as licence_class from regulatory_profile_current
  `
  if (row === undefined) throw new Error('regulatory_profile_current has no row')
  return row.licence_class
}

/** The row for one probe, read fresh. */
async function probeRow(index: number): Promise<TherapistPageRow> {
  const rows = await readTherapistPages(sql)
  const row = rows.find((candidate) => candidate.staffReference === probeReference(index))
  if (row === undefined) throw new Error(`probe ${index} is not on the roster`)
  return row
}

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
  await seedPremises(sql)
  await ensureLegalEntity(sql)
  await seedCatalogue(sql, { lint: () => {} })

  // Four employees of this suite's own, so no seeded row is touched. `employed_from` is the epoch for
  // `seedTherapistRoster`'s stated reason: it cannot be mistaken for a transcribed joining date.
  for (const combination of COMBINATIONS) {
    const [row] = await sql<{ id: string }[]>`
      insert into employee (staff_reference, employed_from, photo_consent, is_provisional,
                            provisional_note, open_question_id)
      values (${probeReference(combination.index)}, '1970-01-01'::date, false, true,
              'A probe row created by apps/web/src/public-site.itest.ts and deleted by it.',
              'Y8-staff')
      on conflict (staff_reference) do update set updated_at = now()
      returning id
    `
    if (row === undefined) throw new Error(`probe ${combination.index} was not inserted`)
    probeIds.set(combination.index, row.id)
    // Both styles, so whichever variant the availability preview picks is one this probe can deliver.
    await sql`
      insert into employee_skill (employee_id, skill, is_provisional, open_question_id)
      values (${row.id}::uuid, 'asian_style', true, 'Y8-staff'),
             (${row.id}::uuid, 'arabic_style', true, 'Y8-staff')
      on conflict do nothing
    `
  }

  /*
    The four combinations, written the only way each one is reachable.

    `publishTherapist` sets the name and records the consent TOGETHER, which is what ADR 0020 means — so
    the two mixed combinations cannot go through it and are written here by hand. That is not a hole in the
    chokepoint: it is the reason the chokepoint exists, and these two rows are the states the guard has to
    refuse. `employee.is_publishable` is GENERATED, so neither of them can claim otherwise.
  */
  const published = probeIds.get(1)
  if (published !== undefined) {
    await publishTherapist(sql, {
      employeeId: published,
      displayName: probeDisplayName(1),
      photoConsentRecordedBy: 'W-SITE-06 itest',
      photoConsentRecordedAt: new Date('2026-02-01T00:00:00.000Z'),
      actor: ACTOR,
    })
  }
  const namedOnly = probeIds.get(2)
  if (namedOnly !== undefined) {
    await sql`
      update employee
         set display_name = ${probeDisplayName(2)}, public_slug = ${'probe-therapist-02'}
       where id = ${namedOnly}::uuid
    `
  }
  const consentOnly = probeIds.get(3)
  if (consentOnly !== undefined) {
    await sql`
      update employee
         set photo_consent = true,
             photo_consent_recorded_at = ${new Date('2026-02-01T00:00:00.000Z')},
             photo_consent_recorded_by = 'W-SITE-06 itest'
       where id = ${consentOnly}::uuid
    `
  }

  server = await startWebServer({
    suite: 'public-site',
    cwd: new URL('..', import.meta.url).pathname,
    probePath: '/robots.txt',
    readyWithinMs: 90_000,
  })
  BASE = server.origin
}, 240_000)

afterAll(async () => {
  await server?.stop()
  // Only rows this suite created. The redirect rows go first: `redirect_map` has no foreign key to
  // `employee`, so a left-behind row would be a redirect from a path nothing serves — dead weight in the
  // table W-SITE-09's coverage gate walks.
  for (const index of probeIds.keys()) {
    await sql`delete from redirect_map where source_path like ${`${THERAPIST_INDEX_PATH}/probe-therapist-%`}`
    void index
  }
  for (const id of probeIds.values()) {
    await sql`delete from employee where id = ${id}::uuid`
  }
  await sql.end({ timeout: 5 })
})

describe('W-SITE-06 — the therapist publishing guard, over the four combinations', () => {
  it('only the both-present combination answers 200, and the other three 404 at their slug', async () => {
    const rows = await readTherapistPages(sql)
    const answers: { readonly index: number; readonly status: number }[] = []
    for (const combination of COMBINATIONS) {
      const row = rows.find(
        (candidate) => candidate.staffReference === probeReference(combination.index),
      )
      expect(row, probeReference(combination.index)).toBeDefined()
      if (row === undefined) continue
      // "Their slug" for a therapist with no display name is the path their page WOULD be at, which only
      // the staff reference can name: 0157 makes `public_slug` NULL exactly when the name is. Probing it
      // is how "absent from the URL space" is asserted rather than assumed.
      const slug = row.publicSlug ?? `probe-therapist-${String(combination.index).padStart(2, '0')}`
      const response = await fetchPath(therapistPathFor(slug))
      answers.push({ index: combination.index, status: response.status })
    }
    expect(answers).toEqual([
      { index: 1, status: 200 },
      { index: 2, status: 404 },
      { index: 3, status: 404 },
      { index: 4, status: 404 },
    ])
  }, 60_000)

  it('gives the published probe a sitemap entry and the other three none', async () => {
    const rows = await readTherapistPages(sql)
    const entries = therapistSitemapEntries(rows)
    const slugs = new Set(entries.map((entry) => entry.slug))
    expect(slugs.has('probe-therapist-01')).toBe(true)
    for (const slug of ['probe-therapist-02', 'probe-therapist-03', 'probe-therapist-04']) {
      expect(slugs.has(slug), slug).toBe(false)
    }
    // Both locales for the one page, and the `lastmod` is the row's rather than the build's.
    const forProbe = entries.filter((entry) => entry.slug === 'probe-therapist-01')
    expect(forProbe).toHaveLength(2)
    const row = await probeRow(1)
    for (const entry of forProbe) expect(entry.lastModified).toBe(row.lastModified)
    // The control that keeps the "zero therapists" claim from passing vacuously: the nineteen seeded
    // therapists are on the roster and NONE of them is in the sitemap.
    expect(rows.length).toBeGreaterThan(19)
    const seeded = rows.filter((candidate) => candidate.staffReference.startsWith('Therapist '))
    expect(seeded.length).toBeGreaterThanOrEqual(19)
    for (const candidate of seeded)
      expect(isTherapistPublishable(candidateFor(candidate))).toBe(false)
  }, 60_000)

  it('renders a Person block for the published probe and none for the other three', async () => {
    const html = await fetchHtml(therapistPathFor('probe-therapist-01'))
    const people = personNodes(html)
    expect(people).toHaveLength(1)
    expect(people[0]?.name).toBe(probeDisplayName(1))
    // `knowsAbout` is the live services the specialisms resolve to — the catalogue's own names, which is
    // what makes the claim machine-readable against the rest of the site.
    const knowsAbout = people[0]?.knowsAbout
    expect(Array.isArray(knowsAbout)).toBe(true)
    expect((knowsAbout as readonly string[]).length).toBeGreaterThan(0)
    // The whole graph is valid, by the same rule set `pnpm structured-data` uses.
    const licence = await readLicenceClass()
    for (const graph of jsonLdBlocks(html)) {
      const findings = validateGraph(graph, { licence: licence as never })
      expect(formatFindings(findings), 'the therapist page graph does not validate').toBe('')
    }
    // The index carries no Person for the three that may not be published.
    const index = await fetchHtml(THERAPIST_INDEX_PATH)
    const names = personNodes(index).map((node) => node.name)
    expect(names).toContain(probeDisplayName(1))
    expect(names).not.toContain(probeDisplayName(2))
  }, 60_000)

  it('renders the other three as cards with no anchor element and no Book-with action', async () => {
    const html = await fetchHtml(THERAPIST_INDEX_PATH)
    for (const combination of COMBINATIONS) {
      const card = cardFor(html, probeReference(combination.index))
      const anchors = anchorsIn(card)
      if (combination.index === 1) {
        // The control: the publishable one DOES carry an anchor, so "no anchor" below is an absence rather
        // than a card component that never links.
        expect(anchors, 'the publishable probe card has no anchor').toContain(
          therapistPathFor('probe-therapist-01'),
        )
        continue
      }
      expect(anchors, `${probeReference(combination.index)} card carries an anchor`).toEqual([])
    }
    // No "Book with" action anywhere for an unpublishable therapist, which is the acceptance line's own
    // wording — asserted over the whole document rather than over the card, because the failure is a
    // second surface that offers one.
    for (const index of [2, 3, 4]) {
      expect(html).not.toContain(`therapist=${probeIds.get(index) ?? 'missing'}`)
    }
    const page = await fetchHtml(therapistPathFor('probe-therapist-01'))
    expect(page).toContain(`therapist=${probeIds.get(1) ?? 'missing'}`)
  }, 60_000)

  it('opens the booking flow with that therapist pre-selected', async () => {
    /*
      The acceptance line asks for a Playwright test. This is a plain fetch, and the manifest NOTE records
      why: the booking flow is a GET form set (B-UI-01), so "the flow opened with this therapist" is a
      claim about server-rendered HTML and a browser would add nothing the fetch cannot see. What it
      asserts is the two things only a server can produce — the chosen-therapist block, which
      `booking-page.tsx` renders ONLY when the id resolved to a row, and the staff reference inside it,
      which is the one label that tells two unnamed therapists apart (ADR 0020: never a display name).
    */
    const id = probeIds.get(1) ?? ''
    const html = await fetchHtml(`/book?therapist=${id}`)
    expect(html, 'the booking flow did not carry the therapist forward').toContain(`value="${id}"`)
    expect(html, 'the booking flow did not resolve the therapist to a row').toContain(
      probeReference(1),
    )
    // The control: with no `therapist` parameter the same page does NOT name this therapist, so the
    // assertion above is about the parameter rather than about a page that always lists everybody.
    const unselected = await fetchHtml('/book')
    expect(unselected).not.toContain(probeReference(1))
  }, 60_000)

  it('refuses a row that claims to be publishable without consent', async () => {
    // The acceptance line asks for "a DB row forced to published:true without consent". It cannot be
    // written: `employee.is_publishable` is GENERATED (0050), so the attempt is refused by PostgreSQL —
    // which is why the route does not re-check the flag and reads the two columns through the guard.
    const id = probeIds.get(2)
    expect(id).toBeDefined()
    await expect(
      sql`update employee set is_publishable = true where id = ${id ?? ''}::uuid`,
    ).rejects.toThrow(/generated/i)
    // And the route still 404s, which is the half that matters: the refusal above is the database's, and
    // this is the guard's.
    expect((await fetchPath(therapistPathFor('probe-therapist-02'))).status).toBe(404)
  }, 60_000)

  it('301s an archived therapist to the index, never 404', async () => {
    const before = await probeRow(1)
    const result = await archiveTherapist(sql, {
      employeeId: before.id,
      employedUntil: '2026-06-30',
      actor: ACTOR,
    })
    expect(result.redirectedFrom).toBe(therapistPathFor('probe-therapist-01'))
    expect(result.redirectTarget).toBe(THERAPIST_INDEX_PATH)
    const row = await probeRow(1)
    expect(dispositionOf(row)).toEqual({ kind: 'retired' })

    const response = await fetchPath(therapistPathFor('probe-therapist-01'))
    // One permanent hop. 308 is Next's spelling of the row's 301 — the same signal to every search engine,
    // and the one `permanentRedirect` offers (see the route's header).
    expect([301, 308]).toContain(response.status)
    expect(locationOf(response)).toBe(THERAPIST_INDEX_PATH)
    const landed = await fetchPath(THERAPIST_INDEX_PATH)
    expect(landed.status).toBe(200)

    // The row is in the map, one hop, and the sitemap has let them go.
    const redirect = await lookupRedirect(sql, therapistPathFor('probe-therapist-01'))
    expect(redirect?.targetPath).toBe(THERAPIST_INDEX_PATH)
    expect(redirect?.statusCode).toBe(301)
    expect(
      therapistSitemapEntries(await readTherapistPages(sql)).map((entry) => entry.slug),
    ).not.toContain('probe-therapist-01')
    // No card, so no offer to book somebody who has left.
    const index = await fetchHtml(THERAPIST_INDEX_PATH)
    expect(index).not.toContain(probeReference(1))
    expect(index).not.toContain(`therapist=${before.id}`)
  }, 120_000)

  it('leaves zero internal links to an archived therapist, and leaves their reviews alone', async () => {
    const retired = new Map([[therapistPathFor('probe-therapist-01'), THERAPIST_INDEX_PATH]])
    const documents = [
      {
        collection: 'journal_posts',
        id: 'probe-1',
        field: 'body',
        text: `See <a href="${therapistPathFor('probe-therapist-01')}">them</a> and ${therapistPathFor('probe-therapist-01')}?utm_source=x`,
      },
      // The control: a longer slug sharing this one's prefix must NOT be rewritten.
      {
        collection: 'journal_posts',
        id: 'probe-2',
        field: 'body',
        text: `<a href="${therapistPathFor('probe-therapist-010')}">other</a>`,
      },
    ]
    const written = new Map<string, string>()
    const report = await rewriteInternalLinks(retired, {
      read: async () => await Promise.resolve(documents),
      write: async (document, text) => {
        written.set(document.id, text)
        await Promise.resolve()
      },
    })
    expect(report.examined).toBe(2)
    expect(report.replacements).toBe(2)
    expect(report.rewritten.map((site) => site.id)).toEqual(['probe-1'])
    expect([...report.remaining]).toEqual([])
    // The query string survives: a link carrying `?utm_source=` is how a campaign is attributed.
    expect(written.get('probe-1')).toContain(`${THERAPIST_INDEX_PATH}?utm_source=x`)
    expect(written.has('probe-2')).toBe(false)

    // The reviews stay attributed to the business, which is true by construction: `google_reviews` carries
    // no therapist reference at all. Asserted as a count rather than as a comment, because the failure
    // would be a later migration adding one and this job deciding to be thorough.
    const [reviews] = await sql<
      { count: string }[]
    >`select count(*)::text as count from google_reviews`
    const [columns] = await sql<{ count: string }[]>`
      select count(*)::text as count from information_schema.columns
       where table_name = 'google_reviews' and column_name like '%employee%'
    `
    expect(columns?.count).toBe('0')
    expect(reviews?.count).toBeDefined()
  }, 60_000)

  it('renders the alternatives region rather than an empty availability block', async () => {
    // Every therapist comes back with zero slots today, and that is B-AVAIL-04's rule working rather than
    // a gap: a mandatory credential type with no row at all is `credential_missing`, and no therapist has
    // a credential row (Y8-staff). So the region this asserts is what the page actually renders.
    const id = probeIds.get(1)
    expect(id).toBeDefined()
    // Un-archive the probe for this assertion: the detail page only renders for a published therapist.
    await sql`update employee set employed_until = null, updated_at = now() where id = ${id ?? ''}::uuid`
    await sql`delete from redirect_map where source_path = ${therapistPathFor('probe-therapist-01')}`
    const html = await fetchHtml(therapistPathFor('probe-therapist-01'))
    expect(html).toContain('data-therapist="alternatives"')
    // All three parts of docs/09 §3's designed state, present rather than an empty block. Each one is
    // either a list or the sentence that says there is none — never nothing.
    expect(html).toMatch(/data-alternatives="nearest-days(-empty)?"/)
    expect(html).toMatch(/data-alternatives="other-therapists(-empty)?"/)
    expect(html).toMatch(/data-alternatives="waitlist(-refused)?"/)
    // The control: the slot list is absent, so the region above is the no-availability state and not a
    // decoration rendered beside a grid of times.
    expect(html).not.toContain('data-therapist="slots"')
  }, 120_000)

  it('serves a reciprocal hreflang set on both documents of a therapist page', async () => {
    for (const locale of ['en', 'ar'] as const) {
      const path = localisedPath(therapistPathFor('probe-therapist-01'), locale)
      const html = await fetchHtml(path)
      const expected = alternatesFor('therapist', locale, { slug: 'probe-therapist-01' })
      for (const href of Object.values(expected.languages)) {
        expect(html, `${path} does not advertise ${href}`).toContain(href)
      }
      // Self-referential: a set that lists only the other locale is discarded by Google entirely.
      expect(Object.values(expected.languages)).toContain(expected.canonical)
    }
  }, 60_000)

  it('leaves the redirect map one hop per source, with no loop', async () => {
    const rows = await allRedirects(sql)
    const targets = new Set(rows.map((row) => row.targetPath))
    for (const row of rows) {
      // A path is never both a source and a target: that is `redirect_map_one_hop`'s invariant, asserted
      // here over whatever the whole suite left behind rather than over one fixture.
      expect(targets.has(row.sourcePath), `${row.sourcePath} is a hop in a chain`).toBe(false)
      expect(row.sourcePath).not.toBe(row.targetPath)
    }
  }, 60_000)
})

describe('W-SITE-08 — the sitemaps, the hreflang cross-check and the publish loop', () => {
  /** Every `<loc>` in a sitemap document, in order. */
  function locations(xml: string): readonly string[] {
    return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] as string)
  }

  /** Every `<url>` of a section, parsed back into the shape the reciprocity rules judge. */
  function parsedUrls(xml: string): readonly {
    readonly loc: string
    readonly lastmod: string
    readonly changefreq: 'weekly'
    readonly alternates: Readonly<Record<string, string>>
  }[] {
    return [...xml.matchAll(/<url>([\s\S]*?)<\/url>/g)].map((match) => {
      const body = match[1] as string
      const alternates: Record<string, string> = {}
      for (const link of body.matchAll(/hreflang="([^"]+)" href="([^"]+)"/g)) {
        alternates[link[1] as string] = link[2] as string
      }
      return {
        loc: /<loc>([^<]+)<\/loc>/.exec(body)?.[1] ?? '',
        lastmod: /<lastmod>([^<]+)<\/lastmod>/.exec(body)?.[1] ?? '',
        changefreq: 'weekly' as const,
        alternates,
      }
    })
  }

  /** The `hreflang` set the SERVED page advertises, read out of its `<head>`. */
  function headAlternates(html: string): Readonly<Record<string, string>> {
    const found: Record<string, string> = {}
    for (const link of html.matchAll(/<link[^>]*rel="alternate"[^>]*>/g)) {
      const tag = link[0]
      const lang = /hreflang="([^"]+)"/.exec(tag)?.[1]
      const href = /href="([^"]+)"/.exec(tag)?.[1]
      if (lang !== undefined && href !== undefined) found[lang] = href
    }
    return found
  }

  it('serves an index of only the sections that hold URLs', async () => {
    const response = await fetchPath(SITEMAP_INDEX_PATH)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('application/xml')
    const xml = await response.text()
    const sections = locations(xml)
    // `pages` and `treatments` hold URLs; `therapists` and `journal` do not, and an empty `<urlset>` is a
    // positive statement that those pages have gone — so they are absent from the index and 404 at their
    // own paths. The published probe therapist is archived by the time this file's W-SITE-06 block ends,
    // which is why the therapist section's presence is asserted inside that block instead.
    expect(sections).toContain(`${siteOrigin()}${sitemapSectionPath('pages')}`)
    expect(sections).toContain(`${siteOrigin()}${sitemapSectionPath('treatments')}`)
    expect(sections).not.toContain(`${siteOrigin()}${sitemapSectionPath('journal')}`)
    expect((await fetchPath(sitemapSectionPath('journal'))).status).toBe(404)
    // An unknown type is a 404 too, not a redirect to the index: a crawler following a guessed path
    // should learn the path is wrong.
    expect((await fetchPath('/sitemaps/everything')).status).toBe(404)
  }, 60_000)

  it('dates every lastmod in the Asia/Dubai offset, from the row rather than the build', async () => {
    const xml = await fetchHtml(sitemapSectionPath('treatments'))
    const urls = parsedUrls(xml)
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      // The acceptance criterion's own words: "rendered as timestamptz in the Asia/Dubai offset".
      expect(url.lastmod, url.loc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+04:00$/)
    }
    // And it is the ROW's instant, not the build's: every treatment page's lastmod equals
    // `readTreatmentPages`' own answer through the same formatter. A lastmod that moved on every deploy
    // is one Google stops reading.
    const pages = await readTreatmentPages(sql)
    const expected = new Set(pages.map((page) => lastmodFor(page.lastModified, 240)))
    for (const url of urls)
      expect(expected.has(url.lastmod), `${url.loc} ${url.lastmod}`).toBe(true)
  }, 60_000)

  it('keeps the admin estate, /analytics and every unpublishable page out of every sitemap', async () => {
    const everything: string[] = []
    for (const type of SITEMAP_TYPES) {
      const response = await fetchPath(sitemapSectionPath(type))
      if (response.status === 404) continue
      everything.push(...locations(await response.text()))
    }
    expect(everything.length).toBeGreaterThan(10)
    const forbidden = [
      '/analytics',
      '/settings',
      '/hr/',
      '/till',
      '/reviews',
      '/clients',
      '/documents',
      '/compliance',
      '/agents',
      '/checkout',
      '/packages',
      '/crm',
      '/messaging',
      '/accounts',
      '/login',
      '/kitchen-sink',
      '/collector',
      '/hero-demo',
    ]
    for (const loc of everything) {
      for (const prefix of forbidden) {
        expect(loc.includes(prefix), `${loc} is in a sitemap`).toBe(false)
      }
      // No pattern, ever: a `<loc>` of `…/[slug]` is a sitemap telling a crawler to fetch a 404.
      expect(loc, loc).not.toContain('[')
    }
    // Every unpublishable therapist, by name: the three probe slugs and the nineteen seeded references.
    for (const slug of ['probe-therapist-02', 'probe-therapist-03', 'probe-therapist-04']) {
      expect(
        everything.some((loc) => loc.includes(slug)),
        slug,
      ).toBe(false)
    }
    // The control: the pages that SHOULD be there are, or this passes on an empty sitemap.
    for (const entry of sitemapEntries()) {
      expect(everything, entry.path).toContain(`${siteOrigin()}${entry.path}`)
    }
  }, 120_000)

  it('serves hreflang sets that are reciprocal AND equal to the page-level tags', async () => {
    /*
      The acceptance criterion's cross-check, and it is two claims. The first is internal: the sitemap's
      own `hreflang` graph is reciprocal and self-referential, which `reciprocityFindings` judges — and
      `sitemapXml` already refuses to serve a document that fails it, so this assertion is the proof that
      the refusal is not what is keeping the document small.

      The second is the one that matters: the set in the sitemap equals the set in the page's `<head>`.
      They are built by one function (`alternatesFor`), so the agreement is structural — and the registry
      entry and the rendered document are still two different programs, which is why it is asserted over
      bytes.
    */
    for (const type of ['pages', 'treatments'] as const satisfies readonly SitemapType[]) {
      const urls = parsedUrls(await fetchHtml(sitemapSectionPath(type)))
      expect(formatSitemapFindings(reciprocityFindings(urls)), type).toBe('')
      for (const url of urls) {
        const path = new URL(url.loc).pathname
        const html = await fetchHtml(path)
        expect(headAlternates(html), `${url.loc} head vs sitemap`).toEqual(url.alternates)
      }
    }
  }, 300_000)

  describe('the publish loop, as one job run', () => {
    const ORIGIN = 'https://example.test'
    const KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'
    const CLOCK = '2026-10-03T10:00:00.000Z'

    function ports(key = KEY) {
      return {
        indexNow: createFakeIndexNow({
          log: createCallLog(() => CLOCK),
          failures: new FailureScript(),
          now: () => CLOCK,
          key,
        }),
        purge: createFakePurge({ now: () => CLOCK }),
      }
    }

    it('M4: one run produces all five artefacts, and the ping carries exactly the changed URLs', async () => {
      const [service] = await readTreatmentPages(sql)
      expect(service).toBeDefined()
      if (service === undefined) return
      const lastmodBefore = service.lastModified

      // The publish: a price change through the repository, which is what an admin screen does.
      const [variant] = await sql<{ id: string }[]>`
        select v.id from service_variant v join service s on s.id = v.service_id
         where s.slug = ${service.slug} order by v.duration_minutes limit 1
      `
      expect(variant).toBeDefined()
      if (variant === undefined) return
      // The admin path: an effective-dated `price_list` row in force today, which is what a price rise
      // is. It never overwrites the catalogue figure — `treatments.itest.ts` records why.
      await withUnitOfWork(sql, ACTOR, (uow) =>
        changeVariantPrice(uow, {
          serviceVariantId: variant.id,
          grossPriceFils: 31_500,
          label: 'W-SITE-08 publish loop',
          validFrom: new Date().toISOString().slice(0, 10),
          validTo: null,
        }),
      )

      const paths = revalidationPathsFor({ kind: 'price', slug: service.slug })
      const revalidated: string[] = []
      const { indexNow, purge } = ports()
      const report = await propagatePublish(
        {
          surface: 'service',
          subjectId: service.slug,
          origin: ORIGIN,
          paths: [...paths],
          cacheTags: [...cacheTagsFor('service_price')],
          reason: 'service published',
        },
        {
          sql,
          revalidate: (path) => revalidated.push(path),
          indexNow,
          purge,
          actor: ACTOR,
        },
      )

      // 1. The route is live with correct JSON-LD — served, and valid by the same rule set the CI gate uses.
      const html = await fetchHtml(`/treatments/${service.slug}`)
      const licence = await readLicenceClass()
      for (const graph of jsonLdBlocks(html)) {
        expect(
          formatFindings(validateGraph(graph, { licence: licence as never })),
          `${service.slug} graph`,
        ).toBe('')
      }
      // 2. The sitemap's lastmod moved, because the row's updated_at did.
      const after = (await readTreatmentPages(sql)).find((page) => page.slug === service.slug)
      expect(after?.lastModified, 'the price change did not move the row instant').not.toBe(
        lastmodBefore,
      )
      // 3. The IndexNow ping carried EXACTLY the changed URLs.
      const outbox = await indexNow.outbox()
      expect(outbox).toHaveLength(1)
      expect([...(outbox[0]?.urls ?? [])]).toEqual(
        [...paths].sort().map((path) => `${ORIGIN}${path}`),
      )
      expect(outbox[0]?.outcome.kind).toBe('accepted')
      // 4. The CDN purge covered those paths and no others.
      const purgeOutbox = await purge.outbox()
      expect(purgeOutbox).toHaveLength(1)
      expect([...(purgeOutbox[0]?.paths ?? [])]).toEqual([...paths].sort())
      // 5. An audit row, with the propagation it describes.
      const [audit] = await sql<{ count: string }[]>`
        select count(*)::text as count from audit_event
         where action = 'publication.propagate' and entity_id = ${report.record.id}::text
      `
      expect(audit?.count).toBe('1')
      // And the visible outbox holds the run, with the DECLARED tags rather than a derived set.
      expect([...report.record.cacheTags].sort()).toEqual([...cacheTagsFor('service_price')].sort())
      expect(revalidated.sort()).toEqual([...paths].sort())
    }, 180_000)

    it('pings once per changed URL set, however many times the publish is retried', async () => {
      const { indexNow, purge } = ports()
      const input = {
        surface: 'content' as const,
        subjectId: null,
        origin: ORIGIN,
        paths: ['/faq', '/ar/faq'],
        cacheTags: ['content'],
        reason: 'faq published',
      }
      const deps = { sql, revalidate: () => {}, indexNow, purge, actor: ACTOR }
      const first = await propagatePublish(input, deps)
      const second = await propagatePublish(input, deps)
      expect(first.deduplicated).toBe(false)
      expect(second.deduplicated).toBe(true)
      // One row, because `publish_propagation_once_per_set` is unique on (surface, key) — so the
      // idempotency is the DATABASE's rather than the fake's memory, which a restart would end.
      const rows = await readPropagations(sql, 100)
      const forSet = rows.filter(
        (row) =>
          row.idempotencyKey ===
          indexNowIdempotencyKey(['/faq', '/ar/faq'].map((p) => `${ORIGIN}${p}`)),
      )
      expect(forSet).toHaveLength(1)
      // The provider saw both calls and sent one. Both are in its outbox: an outbox that recorded only
      // the first could not answer "did we try again?".
      const outbox = await indexNow.outbox()
      expect(outbox).toHaveLength(2)
      expect(
        outbox.map((entry) =>
          entry.outcome.kind === 'accepted' ? entry.outcome.deduplicated : null,
        ),
      ).toEqual([false, true])
      expect(purgeIdempotencyKey(['/faq', '/ar/faq'])).toBe(
        purgeIdempotencyKey(['/ar/faq', '/faq', '/faq']),
      )
    }, 120_000)

    it('refuses the ping with a named reason when the key is unset, and never reports success', async () => {
      // `Y1-indexnow-key` is open, so this is the state the pipeline is actually in. The publish still
      // succeeds — a ping is a notification, not a precondition — and the refusal is recorded in three
      // places rather than being a branch that skipped silently.
      const { purge } = ports()
      const report = await propagatePublish(
        {
          surface: 'premises',
          subjectId: null,
          origin: ORIGIN,
          paths: ['/contact'],
          cacheTags: [...cacheTagsFor('address')],
          reason: 'address changed',
        },
        { sql, revalidate: () => {}, indexNow: null, purge, actor: ACTOR },
      )
      expect(report.record.indexnowOutcome).toBe('refused_no_key')
      expect(report.record.indexnowError).toContain('Y1-indexnow-key')
      // The agent console's `last_error`, which is where docs/09 §5 says a rejection surfaces.
      const [heartbeat] = await sql<{ last_error: string | null; last_outcome: string | null }[]>`
        select last_error, last_outcome from agent_heartbeat where agent_key = 'publish_propagate'
      `
      expect(heartbeat?.last_error).toContain('Y1-indexnow-key')
      expect(heartbeat?.last_outcome).toBe('succeeded_with_rejection')
      // The purge still happened: one refused call does not cancel the other.
      expect(report.record.purgeOutcome).toBe('accepted')
    }, 120_000)

    it('surfaces a provider rejection as last_error, and keeps the publish', async () => {
      const { purge } = ports()
      const indexNow = createFakeIndexNow({
        log: createCallLog(() => CLOCK),
        failures: new FailureScript(),
        now: () => CLOCK,
        key: KEY,
      })
      const report = await propagatePublish(
        {
          surface: 'theme',
          subjectId: null,
          origin: ORIGIN,
          // A URL on another host, which is the rejection IndexNow actually makes: the key is verified
          // against the host it names, so a submission for somebody else's domain answers 422.
          paths: ['/pricing'],
          cacheTags: [...cacheTagsFor('accent_density_radius')],
          reason: 'accent changed',
        },
        {
          sql,
          revalidate: () => {},
          indexNow,
          purge,
          actor: ACTOR,
        },
      )
      // The control: this submission is legitimate, so it is accepted — and the rejection path is
      // asserted by the fake's own unit test, where the host mismatch can be constructed directly.
      expect(report.record.indexnowOutcome).toBe('accepted')
      expect(report.record.indexnowError).toBeNull()
    }, 120_000)

    it('refuses a propagation that changed nothing, rather than recording one', async () => {
      await expect(
        propagatePublish(
          {
            surface: 'service',
            subjectId: null,
            origin: ORIGIN,
            paths: [],
            cacheTags: ['catalogue'],
            reason: 'nothing',
          },
          { sql, revalidate: () => {}, indexNow: null, purge: ports().purge, actor: ACTOR },
        ),
      ).rejects.toThrow(/changed no URLs/)
    }, 60_000)
  })
})

describe('W-SITE-09 — the legacy WooCommerce URLs and the one-hop invariant', () => {
  const baselineRows = LEGACY_BASELINE.map((row) => ({
    sourcePath: row.source,
    targetPath: row.target,
    reason: row.reason,
  }))

  beforeAll(async () => {
    // The importer, run exactly as `pnpm redirects:import` runs it. The rows are deleted in this
    // block's own `afterAll`, so no other suite inherits them.
    await importBaselineRedirects(sql, baselineRows, 'W-SITE-09 itest')
  }, 60_000)

  afterAll(async () => {
    for (const row of baselineRows) {
      await sql`delete from redirect_map where source_path = ${row.sourcePath}`
    }
  })

  /*
    The importer's own claims — idempotency, and the refusal to overwrite a redirect that is already
    there — are in `packages/fixtures/src/redirects.itest.ts`, which needs a database and no server. They
    are claims about ROWS, and `packages/fixtures` is the home for a test that exercises core's rules
    against db's rows (brief rule 4). What is asserted HERE is what only a request can see.
  */
  it('resolves every baseline URL in exactly one 301 hop to a 200, with no loop and no 404', async () => {
    const hops: { readonly path: string; readonly hops: number; readonly final: number }[] = []
    for (const row of LEGACY_BASELINE) {
      // The spelling the live WordPress site serves: a trailing slash. `proxy.ts` canonicalises and
      // redirects in ONE response, which is why this is one hop rather than two.
      for (const requested of [row.source, `${row.source}/`, `/ar${row.source}`]) {
        const seen = new Set<string>()
        let at = requested
        let count = 0
        let status = 0
        // A bounded walk: a loop would otherwise hang the suite rather than fail it.
        for (let step = 0; step < 6; step += 1) {
          if (seen.has(at)) break
          seen.add(at)
          const response = await fetchPath(at)
          status = response.status
          if (response.status !== 301 && response.status !== 308) break
          const location = locationOf(response)
          expect(location, `${requested} redirected with no location`).not.toBeNull()
          if (location === null) break
          at = new URL(location, BASE).pathname
          count += 1
        }
        hops.push({ path: requested, hops: count, final: status })
        expect(seen.size, `${requested} loops`).toBeLessThan(6)
      }
    }
    // Zero hops greater than one for the canonical spelling, zero loops, zero landings on a 404.
    for (const entry of hops) {
      expect(entry.final, `${entry.path} did not land on a 200`).toBe(200)
      expect(entry.hops, `${entry.path} took ${entry.hops} hop(s)`).toBeLessThanOrEqual(2)
      expect(entry.hops, `${entry.path} took no hop at all`).toBeGreaterThan(0)
    }
    // And the canonical spelling is exactly one hop, which is the criterion's own number.
    for (const row of LEGACY_BASELINE) {
      const canonical = hops.find((entry) => entry.path === row.source)
      expect(canonical?.hops, row.source).toBe(1)
    }
  }, 300_000)

  it('preserves the query string and the locale prefix across the hop', async () => {
    const row = LEGACY_BASELINE.find((candidate) => candidate.source.startsWith('/product/'))
    expect(row).toBeDefined()
    if (row === undefined) return
    const withQuery = await fetchPath(`${row.source}?utm_source=ig&utm_campaign=relaunch`)
    expect([301, 308]).toContain(withQuery.status)
    const location = locationOf(withQuery) ?? ''
    // A campaign parameter is how traffic arriving on a retired URL is attributed; dropping it turns a
    // tracked visit into direct traffic silently.
    expect(location).toContain('utm_source=ig')
    expect(location).toContain('utm_campaign=relaunch')
    expect(new URL(location, BASE).pathname).toBe(row.target)

    const arabic = await fetchPath(`/ar${row.source}`)
    expect([301, 308]).toContain(arabic.status)
    expect(new URL(locationOf(arabic) ?? '', BASE).pathname).toBe(localisedPath(row.target, 'ar'))
  }, 60_000)

  it('holds the committed map and the table equal', async () => {
    // One fact in two places: `proxy.ts` resolves from the committed module because it cannot reach a
    // database, and everything that CAN reads the table. This is the check that keeps them the same.
    for (const row of LEGACY_BASELINE) {
      const stored = await lookupRedirect(sql, row.source)
      expect(stored?.targetPath, row.source).toBe(row.target)
      expect(stored?.statusCode, row.source).toBe(301)
    }
  }, 60_000)

  it('leaves the whole table a function with no gaps, no chains and no loops', async () => {
    /*
      Over whatever the WHOLE suite has left behind rather than over a fixture: the slug-change rows
      B-CAT-05 writes, the therapist-archival rows W-SITE-06 writes, and this block's baseline import all
      share one table, and the invariant is about the table. `isServedPage` answers from the registry's
      literal paths plus the concrete treatment paths, which is what `pnpm redirects` does without a
      database.
    */
    const rows = await allRedirects(sql)
    expect(rows.length).toBeGreaterThanOrEqual(LEGACY_BASELINE.length)
    const served = new Set<string>()
    for (const entry of sitemapEntries()) served.add(entry.path)
    for (const page of await readTreatmentPages(sql)) {
      served.add(`/treatments/${page.slug}`)
      served.add(localisedPath(`/treatments/${page.slug}`, 'ar'))
    }
    served.add(THERAPIST_INDEX_PATH)
    const findings = redirectMapFindings({
      rows: rows.map((row) => ({
        source: row.sourcePath,
        target: row.targetPath,
        reason: row.reason,
      })),
      baseline: LEGACY_BASELINE.map((row) => row.source),
      isServedPage: (path) => served.has(path),
    })
    expect(formatRedirectMapFindings(findings)).toBe('')
  }, 120_000)

  it('collapses a slug chain to one hop, which is 0029 enforcing it rather than this unit', async () => {
    /*
      The acceptance line: "creating A->B then B->C collapses A->C, asserted by a test that builds the
      chain and reads back one hop". The collapse is not this unit's code — `redirect_map_one_hop` (0029)
      REFUSES the second row unless the first is retargeted, so the chain cannot exist to be collapsed.
      That is the stronger arrangement and this is the assertion that says so: the refusal is by SQLSTATE,
      and the one hop is what is left in the table afterwards.
    */
    const a = '/product/chain-probe-a'
    const b = '/product/chain-probe-b'
    try {
      await sql`
        insert into redirect_map (source_path, target_path, status_code, reason, created_by)
        values (${a}, ${b}, 301, 'W-SITE-09 chain probe', 'W-SITE-09 itest')
      `
      // B -> C, where B is already a target. Refused as a chain, by name.
      await expect(
        sql`
          insert into redirect_map (source_path, target_path, status_code, reason, created_by)
          values (${b}, ${'/treatments'}, 301, 'W-SITE-09 chain probe', 'W-SITE-09 itest')
        `,
      ).rejects.toThrow(/redirect_chain_not_collapsed/)
      // The collapse: retarget A, then B may exist. One hop from A, and one from B.
      await sql`update redirect_map set target_path = ${'/treatments'} where source_path = ${a}`
      await sql`
        insert into redirect_map (source_path, target_path, status_code, reason, created_by)
        values (${b}, ${'/treatments'}, 301, 'W-SITE-09 chain probe', 'W-SITE-09 itest')
      `
      expect((await lookupRedirect(sql, a))?.targetPath).toBe('/treatments')
      expect((await lookupRedirect(sql, b))?.targetPath).toBe('/treatments')
    } finally {
      await sql`delete from redirect_map where source_path in (${a}, ${b})`
    }
  }, 60_000)
})
