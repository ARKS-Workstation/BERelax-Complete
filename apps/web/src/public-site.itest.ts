import { formatFindings, isTherapistPublishable, validateGraph } from '@berelax/core'
import {
  allRedirects,
  createConnection,
  ensureLegalEntity,
  lookupRedirect,
  readTherapistPages,
  type Sql,
  seedCatalogue,
  seedPremises,
  THERAPIST_INDEX_PATH,
  type TherapistPageRow,
  therapistPathFor,
} from '@berelax/db'
import { startWebServer, type WebServer } from '@berelax/harness/server'
import { archiveTherapist, publishTherapist } from '@berelax/hr'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { localisedPath } from './i18n/locales.ts'
import { rewriteInternalLinks } from './jobs/rewrite-internal-links.ts'
import { alternatesFor } from './routes/alternates.ts'
import { candidateFor, dispositionOf } from './therapists/read.ts'
import { therapistSitemapEntries } from './therapists/sitemap.ts'

/**
 * The public site's served bytes: W-SITE-06's therapist routes and the publishing guard.
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
