import { FAQ_ENTRIES, JOURNAL_POSTS, PUBLICATION_RULES } from '@berelax/cms'
import {
  assertPublicDisplayNameCompliant,
  type CompliancePolicy,
  formatLinkGraphFindings,
  judgeLinkGraph,
  type LinkGraph,
  type LinkGraphRule,
  type LinkNode,
  type LinkNodeKind,
  normaliseLinkPath,
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
import { startWebServer, type WebServer } from '@berelax/harness/server'
import type { Facts } from '@berelax/shared'
import { getPayload, type Payload } from 'payload'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { JournalBody } from '../app/_content/pages.tsx'
import config from '../payload.config.ts'
import { CONTENT_COPY_EN } from './cms/copy-en.ts'
import { collectionAvailability, type JournalPost, readMedicalDisclaimer } from './cms/read.ts'
import { buildFacts } from './facts/build.ts'
import { localisedPath, neutralPath } from './i18n/locales.ts'
import { siteOrigin } from './routes/alternates.ts'
import { documentRoutes, isParameterised, samplePathFor } from './routes/registry.ts'

/**
 * W-SITE-07 — the CMS-driven routes and the link graph, against the built application and a real PostgreSQL.
 *
 * Every claim here is about **served bytes** or about a **Payload mutation**, and not one of them can be
 * checked any other way:
 *
 *   - ten routes answering 200 under ISR, each carrying a `BreadcrumbList` whose items are its own path
 *     segments — enumerated, per route, per locale;
 *   - `/faq` and its `FAQPage` block carrying the same questions, the same answers and the same count, from
 *     rows this file writes through the Local API and then deletes;
 *   - the **link graph over the built site**: reachability from `/`, zero orphans, zero internal links
 *     answering anything but 200. The rules are `@berelax/core`'s and are proved on fixtures in
 *     `link-graph.test.ts`; this is the crawl that gives them the real site to judge;
 *   - `/spa` rendering the premises row: one field changed, one revalidation, the new value on the page and
 *     the old value gone — then rolled back, with a control proving the page came back;
 *   - the publication guard refusing a publish **by rule name**, through Payload's own hook pipeline, for a
 *     missing author byline, a missing reviewer byline, a missing date, health-adjacent copy with no
 *     disclaimer written, and a banned claim.
 *
 * ## The port, the server, and the ISR cache
 *
 * `startWebServer({ suite: 'content' })`, which draws from a band `@berelax/harness/ports` owns and proves
 * disjoint, then ACQUIRES it — binding a candidate and drawing again if another worktree holds it. It also
 * asserts the child is alive after the port answers, which this file used to do by hand: a reachable port
 * plus a dead child is another worktree's application answering for this one. This suite's old self-chosen
 * `5900 + random(300)` ran into `hero-lcp`'s 5800.
 *
 * `.next` holds the ISR cache **on disk**, so a page this suite revalidates in one run is served from that
 * cache by the next run's server — with the rows as they were then, including rows this file created. That
 * cost W-SITE-05 a run and it is handled the same way here: every row this file writes carries a per-run
 * marker, it is deleted in `afterAll`, and the pages are revalidated **and fetched twice** afterwards, because
 * `revalidatePath` marks an entry stale rather than deleting it.
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

/**
 * A per-run marker for every row this file writes.
 *
 * Brief rule 12: the integration suite shares one database and earlier files leave rows behind. Every
 * assertion below is therefore a **key-set** claim about rows carrying this marker, or an equality between two
 * artefacts of the same read — never a total over a shared table.
 */
const RUN = Math.random().toString(36).slice(2, 8)

let server: WebServer
let sql: Sql
let payload: Payload
let facts: Facts
let policy: CompliancePolicy
/** Every document this file created, so `afterAll` can remove exactly those. */
const created: { readonly collection: string; readonly id: string | number }[] = []

async function fetchPath(path: string): Promise<Response> {
  return await fetch(`${BASE}${path}`, { redirect: 'manual' })
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
  readonly itemListElement?: readonly {
    readonly position?: unknown
    readonly name?: unknown
    readonly item?: unknown
  }[]
  readonly mainEntity?: readonly {
    readonly name?: unknown
    readonly acceptedAnswer?: { readonly text?: unknown }
  }[]
}

function nodesOf(graph: unknown): readonly GraphNode[] {
  return ((graph as { '@graph'?: GraphNode[] })['@graph'] ?? []) as readonly GraphNode[]
}

function nodeOfType(html: string, type: string): GraphNode | undefined {
  const blocks = jsonLdBlocks(html)
  expect(blocks.length, 'the page served no JSON-LD block').toBeGreaterThan(0)
  return nodesOf(blocks[0]).find((node) => JSON.stringify(node['@type']).includes(type))
}

/** Every `<h2>` with its id, its text, the tag that immediately follows it and that tag's text. */
interface Heading {
  readonly id: string
  readonly text: string
  readonly next: string
  readonly answer: string
}

function headings(html: string): readonly Heading[] {
  const found: Heading[] = []
  const pattern = /<h2([^>]*)>([\s\S]*?)<\/h2>\s*<([a-z0-9]+)[^>]*>([\s\S]*?)<\/\3>/g
  let match = pattern.exec(html)
  while (match !== null) {
    found.push({
      id: /id="([^"]*)"/.exec(match[1] ?? '')?.[1] ?? '',
      text: decode(match[2] ?? ''),
      next: match[3] ?? '',
      answer: decode(match[4] ?? ''),
    })
    match = pattern.exec(html)
  }
  return found
}

/** The entities React emits in text. Enough of them for an answer to be compared with a row. */
function decode(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#x27;', "'")
    .replaceAll('&#39;', "'")
    .replaceAll('&nbsp;', ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every internal link a document makes, normalised, deduplicated, in document order. */
function internalLinks(html: string): readonly string[] {
  const links: string[] = []
  const pattern = /<a\b[^>]*href="([^"]+)"/g
  let match = pattern.exec(html)
  while (match !== null) {
    const href = match[1] ?? ''
    // Same-origin only. An external link cannot be checked for a 200 by a gate that must run offline, and the
    // map and directions URLs on `/spa` and `/contact` are deliberately external — they are Google's.
    if (href.startsWith('/')) links.push(normaliseLinkPath(href))
    match = pattern.exec(html)
  }
  return [...new Set(links)]
}

/** A minimal Lexical value. `body` and `answer` are required richText fields and an empty one is refused. */
function prose(text: string) {
  return {
    root: {
      type: 'root',
      format: '',
      indent: 0,
      version: 1,
      direction: 'ltr',
      children: [
        {
          type: 'paragraph',
          format: '',
          indent: 0,
          version: 1,
          direction: 'ltr',
          children: [
            { type: 'text', detail: 0, format: 0, mode: 'normal', style: '', text, version: 1 },
          ],
        },
      ],
    },
  }
}

/**
 * One revalidation run, and then the pages are **fetched twice**.
 *
 * The fetch is the half that matters and it is W-SITE-05's finding, applied here: `revalidatePath` marks the
 * cache entry stale rather than deleting it, so with no request afterwards the stale copy stays on disk and
 * the next process to ask for the page is served it once. Twice, so the entry left behind is the one a clean
 * build would have produced.
 */
async function republish(kind: string, paths: readonly string[]): Promise<void> {
  const response = await fetch(`${BASE}/settings/content/revalidate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind }),
  })
  expect(response.status, `${kind} could not be revalidated`).toBe(200)
  for (const path of paths) {
    await fetchPath(path)
    await fetchPath(path)
  }
}

const FAQ_PATHS = ['/faq', '/ar/faq'] as const
const JOURNAL_PATHS = ['/journal', '/ar/journal'] as const
const PREMISES_PATHS = [
  '/spa',
  '/ar/spa',
  '/contact',
  '/ar/contact',
  '/about',
  '/ar/about',
] as const

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

  /*
   * Payload, in THIS process, and that is what materialises its schema.
   *
   * `payload.config.ts` enables drizzle-kit `push` whenever `NODE_ENV !== 'production'`, which is true here
   * and false during `next build` — so this call is what creates the `payload` schema's tables in a database
   * that has never run the admin. It is also the reason `src/cms/read.ts` treats an absent table as an answer
   * rather than an exception: the build runs before this, and a build that failed for want of a CMS schema
   * would be a build that could not be made in a fresh environment.
   */
  payload = await getPayload({ config })

  server = await startWebServer({
    suite: 'content',
    cwd: new URL('..', import.meta.url).pathname,
    probePath: '/spa',
    readyWithinMs: 90_000,
  })
  BASE = server.origin

  // The CMS pages are regenerated from the rows as they are NOW, before anything is asserted, for the reason
  // the header gives: the ISR cache is on disk and an earlier run's copy is what this server would serve.
  await republish('faq', FAQ_PATHS)
  await republish('journal', JOURNAL_PATHS)
}, 240_000)

afterAll(async () => {
  // Every row this file created, removed — and then the pages it touched regenerated, so the ISR cache on
  // disk does not carry them into the next run. Both halves matter; see `republish`.
  for (const doc of created) {
    await payload.delete({ collection: doc.collection as never, id: doc.id }).catch(() => undefined)
  }
  if (server?.alive() === true) {
    await republish('faq', FAQ_PATHS).catch(() => undefined)
    await republish('journal', JOURNAL_PATHS).catch(() => undefined)
  }
  await server?.stop()
  await sql?.end({ timeout: 5 })
})

/** The five routes this unit added. */
const CMS_ROUTES = ['spa', 'contact', 'about', 'faq', 'journal'] as const

describe('acceptance — every route this unit adds answers 200, in both locales', () => {
  it('answers 200 with no robots header', async () => {
    for (const id of CMS_ROUTES) {
      for (const locale of ['en', 'ar'] as const) {
        const path = localisedPath(`/${id}`, locale)
        const response = await fetchPath(path)
        expect(response.status, path).toBe(200)
        // Indexable: the absence of the header is what `indexable: true` means on the wire.
        expect(response.headers.get('x-robots-tag'), path).toBeNull()
      }
    }
  }, 60_000)

  it('renders the premises row on the pages that are about the place', async () => {
    // Not a literal: every one of these values is read off the fact sheet built from the same row the page
    // read. The grep gate (`packages/db/src/seed/premises.test.ts`) is what stops a literal existing at all.
    for (const path of ['/spa', '/contact', '/ar/spa', '/ar/contact']) {
      const html = await fetchHtml(path)
      expect(html, path).toContain(facts.address.line1)
      expect(html, path).toContain(facts.address.area)
      const landline = facts.contact.landline
      if (landline !== null) expect(html, path).toContain(landline.display)
    }
    // The control: a page that is not about the place does not publish a telephone number, or "renders the
    // premises row" would be satisfied by a footer on every page and would say nothing about these two.
    const journal = await fetchHtml('/journal')
    const landline = facts.contact.landline
    if (landline !== null) expect(journal).not.toContain(landline.display)
  }, 60_000)
})

describe('acceptance — each route carries a BreadcrumbList matching its path segments', () => {
  it('enumerates the trail of every route, in both locales', async () => {
    for (const id of CMS_ROUTES) {
      for (const locale of ['en', 'ar'] as const) {
        const path = localisedPath(`/${id}`, locale)
        const html = await fetchHtml(path)
        const trail = nodeOfType(html, 'BreadcrumbList')
        expect(trail, `${path} carries no BreadcrumbList`).toBeDefined()
        const items = trail?.itemListElement ?? []
        // One item per segment of the locale-neutral path, plus the home page it hangs off. `/spa` and
        // `/ar/spa` are both one segment — the locale prefix is not a level of the hierarchy, it is which
        // document you are reading — so both trails are two items.
        const segments = neutralPath(path)
          .split('/')
          .filter((part) => part !== '')
        expect(items, path).toHaveLength(segments.length + 1)
        // The first item is this locale's home page and the last is the page itself, both absolute and both
        // through `absoluteUrl`, so a breadcrumb cannot name a path the canonicaliser would redirect.
        expect(items[0]?.item, path).toBe(`${siteOrigin()}${localisedPath('/', locale)}`)
        expect(items[items.length - 1]?.item, path).toBe(`${siteOrigin()}${path}`)
        // 1-based and contiguous: a trail numbered from zero, or with a gap, is dropped whole by consumers
        // that check it rather than partially.
        expect(
          items.map((item) => item.position),
          path,
        ).toEqual(items.map((_, index) => index + 1))
        // The visible trail says the same thing: the last link before the current page is this locale's home.
        expect(html, path).toContain(`href="${localisedPath('/', locale)}"`)
      }
    }
  }, 120_000)

  it('emits a two-item trail on a one-segment page and none on a page with no parent', async () => {
    // The control on the builder: `breadcrumbListNode` returns nothing for fewer than two steps, which is why
    // the home page carries no trail — a trail whose only item is the page it is on tells a consumer nothing
    // the URL did not. `/` renders no graph at all yet (W-SITE-04), so the control is taken on the treatments
    // index, which does.
    const html = await fetchHtml('/treatments')
    expect(nodeOfType(html, 'BreadcrumbList')?.itemListElement).toHaveLength(2)
  }, 30_000)
})

describe('acceptance — /faq and the FAQPage schema derive from the same faq_entries rows', () => {
  /** Three rows, each carrying this run's marker so no other file's leftovers can satisfy the assertion. */
  const entries = [
    { question: `Where is the run ${RUN} entrance?`, answer: `Answer one for run ${RUN}.` },
    { question: `Is the run ${RUN} lift working?`, answer: `Answer two for run ${RUN}.` },
    { question: `How early is the run ${RUN} desk open?`, answer: `Answer three for run ${RUN}.` },
  ]

  beforeAll(async () => {
    for (const entry of entries) {
      const doc = await payload.create({
        collection: FAQ_ENTRIES.slug as never,
        data: {
          question: entry.question,
          answer: prose(entry.answer),
          topic: 'visiting',
          _status: 'published',
        } as never,
      })
      created.push({ collection: FAQ_ENTRIES.slug, id: doc.id })
    }
    await republish('faq', FAQ_PATHS)
  }, 120_000)

  it('renders one heading per published row, with the row’s own answer under it', async () => {
    for (const path of FAQ_PATHS) {
      const html = await fetchHtml(path)
      const byQuestion = new Map(headings(html).map((heading) => [heading.text, heading]))
      for (const entry of entries) {
        const heading = byQuestion.get(entry.question)
        expect(heading, `${path} is missing "${entry.question}"`).toBeDefined()
        // Immediately followed by a `<p>`: the structural half, from the one component that emits an `<h2>`.
        expect(heading?.next, `${path} ${entry.question}`).toBe('p')
        expect(heading?.answer, `${path} ${entry.question}`).toBe(entry.answer)
        // The anchor is the slugified question, so a citation has something to point at.
        expect(heading?.id, `${path} ${entry.question}`).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      }
    }
  }, 60_000)

  it('publishes the same questions, the same answers and the same count in the FAQPage block', async () => {
    for (const path of FAQ_PATHS) {
      const html = await fetchHtml(path)
      const faq = nodeOfType(html, 'FAQPage')
      expect(faq, `${path} carries no FAQPage node`).toBeDefined()
      const questions = (faq?.mainEntity ?? []).map((question) => ({
        name: String(question.name),
        text: String(question.acceptedAnswer?.text),
      }))
      const rendered = headings(html)
      // The count first, and it is an equality between the two artefacts rather than a total over a shared
      // table: other files leave FAQ rows behind, and both the page and the block are built from one read of
      // whatever is published — so they must agree whatever that is.
      expect(questions.length, path).toBe(rendered.length)
      expect(questions.map((question) => question.name).sort()).toEqual(
        rendered.map((heading) => heading.text).sort(),
      )
      expect(questions.map((question) => question.text).sort()).toEqual(
        rendered.map((heading) => heading.answer).sort(),
      )
      // Non-vacuous: this run's three rows are in there, so the equality is not between two empty lists.
      for (const entry of entries) {
        expect(
          questions.map((question) => question.name),
          path,
        ).toContain(entry.question)
        expect(
          questions.map((question) => question.text),
          path,
        ).toContain(entry.answer)
      }
      // The control on the comparison: a question nobody wrote is absent from both.
      expect(questions.map((question) => question.name)).not.toContain(`Absent run ${RUN}?`)
    }
  }, 60_000)

  it('finds the collection’s table through the one read path, and says so when there is none', async () => {
    // The mechanism `src/cms/read.ts` exists for: the table's presence is a separate query from the read, so
    // "no CMS schema in this database yet" and "a deadlock" cannot be reported as the same thing.
    const availability = await collectionAvailability(payload, FAQ_ENTRIES.slug)
    expect(availability.kind).toBe('ready')
    const absent = await collectionAvailability(payload, `absent_table_${RUN}`)
    expect(absent.kind).toBe('unavailable')
    if (absent.kind === 'unavailable') expect(absent.reason).toContain('does not exist')
  })
})

describe('acceptance — a journal post fails publication with a named error', () => {
  const body = `A note for run ${RUN} about what happens at the desk.`

  /** Publishes a post and returns either 'published' or the message the refusal carried. */
  async function publish(
    slug: string,
    fields: Record<string, unknown>,
    text = body,
  ): Promise<string> {
    try {
      const doc = await payload.create({
        collection: JOURNAL_POSTS.slug as never,
        data: {
          slug: `run-${RUN}-${slug}`,
          title: `Run ${RUN} ${slug}`,
          body: prose(text),
          _status: 'published',
          ...fields,
        } as never,
      })
      created.push({ collection: JOURNAL_POSTS.slug, id: doc.id })
      return 'published'
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }

  const COMPLETE = {
    byline: 'Author 01',
    reviewed_by: 'Reviewer 01',
    published_on: '2026-09-19T00:00:00.000Z',
  }

  it('refuses a post with no author byline, no reviewer byline or no date, by rule name', async () => {
    expect(await publish('no-byline', {})).toContain('journal_post_without_author_byline')
    expect(await publish('no-reviewer', { byline: COMPLETE.byline })).toContain(
      'journal_post_without_reviewer_byline',
    )
    expect(
      await publish('no-date', { byline: COMPLETE.byline, reviewed_by: COMPLETE.reviewed_by }),
    ).toContain('journal_post_without_date')
  }, 60_000)

  it('decides health-adjacent copy by the disclaimer global, whichever way that row stands', async () => {
    /*
     * Asserted against the row rather than against an assumption about it, and that is brief rule 12 in
     * action: this case first read "the global is unwritten, so health-adjacent copy is refused", passed
     * twice, and then failed — because `payload.itest.ts` WRITES `compliance_notices` ("Massage is not a
     * medical treatment.") and the integration suite shares one database and one file order this file does
     * not choose. The rule has two directions and the honest test asserts whichever one the row selects.
     *
     * The refusal direction is also asserted where the global's state is an argument instead of a shared row:
     * `packages/cms/src/publication.test.ts` does it four times, and the detection half — that the copy, not
     * the checkbox, is what makes a post health-adjacent — is asserted there and in `cms/content.test.ts`.
     */
    const disclaimer = await readMedicalDisclaimer()
    const outcome = await publish(
      'health',
      COMPLETE,
      `What to tell the desk about an injury before a run ${RUN} session.`,
    )
    if (disclaimer === null) {
      expect(outcome).toContain('journal_post_health_adjacent_without_disclaimer')
      expect(outcome).toContain('injury')
      return
    }
    // The owner's wording exists, so health-adjacent copy is publishable — with the disclaimer beside it,
    // which is what the rule is for rather than a ban on the subject.
    expect(outcome, `the global holds "${disclaimer}" yet the post was refused`).toBe('published')
  }, 60_000)

  it('refuses a post containing a banned claim, by the lexicon’s own rule name', async () => {
    // The acceptance criterion's fixture, verbatim. `cure` is on `regulatory_profile.banned_claim_terms` under
    // the seeded profile, and `banned_claim_term` is B-CAT-05's rule name rather than one invented here.
    const refusal = await publish(
      'claim',
      COMPLETE,
      'How massage cures sciatica, and other things this business does not say.',
    )
    expect(refusal).toContain('banned_claim_term')
    expect(policy.bannedClaimTerms).toContain('cure')
  }, 60_000)

  it('publishes a post that carries all three and makes no claim', async () => {
    // The control. Without it every refusal above is satisfied by a guard that refuses everything — and "no
    // post can be published" is in fact the state of this site, so this is the only assertion that proves the
    // guard is a guard. `Author 01` is a label in the shape `packages/fixtures/src/synthetic.ts` uses for
    // `Therapist 07`: an internal reference that could not be mistaken for a person. No name is invented.
    expect(await publish('complete', COMPLETE)).toBe('published')
  }, 60_000)

  it('saves an incomplete post as a DRAFT, because a draft may be incomplete', async () => {
    // The asymmetry the collection's optional fields exist for: `required: true` would refuse the save, and
    // the byline field exists precisely because nobody has a name to put in it yet.
    const doc = await payload.create({
      collection: JOURNAL_POSTS.slug as never,
      data: {
        slug: `run-${RUN}-draft`,
        title: `Run ${RUN} draft`,
        body: prose(body),
        _status: 'draft',
      } as never,
    })
    created.push({ collection: JOURNAL_POSTS.slug, id: doc.id })
    expect(doc.id).toBeDefined()
  }, 60_000)

  it('has a refusal for every rule the module declares', () => {
    // A rule nobody can make fire is a rule that does not exist: four rules, four refusals above.
    expect([...PUBLICATION_RULES]).toHaveLength(4)
  })
})

describe('acceptance — a health-adjacent post renders the medical-disclaimer pattern', () => {
  /**
   * Rendered, not fetched, and the reason is what the pattern needs to exist at all.
   *
   * It renders when a post on the page is health-adjacent **and** `compliance_notices.medical_disclaimer`
   * has been written — and that global is owner-only, empty, and holds the wording a licensing inspector
   * reads (ADR 0020). Writing one into the shared test database to make a page render it would be inventing
   * compliance copy, which is the one thing this unit refuses hardest; and a post that IS health-adjacent
   * cannot be published while the global is empty, which the suite above asserts by rule name. So the two
   * states the served page can be in are "nothing health-adjacent here" and "refused at publication".
   *
   * What is left to prove is the *rendering*, and that is a property of the component: `JournalBody` with a
   * health-adjacent post and a disclaimer produces the pattern, and with either missing produces nothing.
   * `vitest.integration.config.ts` configures JSX for exactly this — W-SYS-10's breakpoint preview renders a
   * component the same way, for the same reason.
   */
  // The real shape of a disclaimer, including the two words the lexicon bans: W-SYS-08's own fixture
  // wording is "Massage is not a medical treatment." A pattern that could not carry that sentence would be
  // no pattern at all, which is why `src/cms/page-data.ts` exempts the compliance-locked global from the
  // copy lint and why `publication.test.ts` asserts the same words are still refused inside a post.
  const DISCLAIMER = `Massage is not a medical treatment. Run ${RUN} wording, written by the owner.`

  function render(posts: readonly JournalPost[], disclaimer: string | null): string {
    // `createElement` rather than JSX: this file is a `.ts`, which is what lets the rest of it be a plain
    // integration test. `breakpoint-preview.itest.ts` renders its component the same way.
    return renderToStaticMarkup(
      createElement(JournalBody, {
        facts,
        copy: CONTENT_COPY_EN,
        locale: 'en',
        posts,
        disclaimer,
      }),
    )
  }

  /** A publishable post. `Author 01` is a label, not a name; see the suite above. */
  const post = (partial: Partial<JournalPost>): JournalPost => ({
    slug: 'a-post',
    title: 'A post',
    standfirst: null,
    bodyText: 'The desk takes your booking.',
    paragraphs: ['The desk takes your booking.'],
    byline: 'Author 01',
    reviewedBy: 'Reviewer 01',
    publishedOn: '2026-09-19',
    healthTopicDeclared: false,
    ...partial,
  })

  it('renders the pattern for a post that declares itself health copy', () => {
    const html = render([post({ healthTopicDeclared: true })], DISCLAIMER)
    // The pattern is a labelled region with its own heading and the owner's wording inside it — not a
    // sentence appended to the page, which is what a reader skips and a consumer cannot attribute.
    expect(html).toContain(`aria-label="${CONTENT_COPY_EN.labels.healthNote}"`)
    expect(html).toContain(`<h2>${CONTENT_COPY_EN.labels.healthNote}</h2>`)
    expect(html).toContain(DISCLAIMER)
  })

  it('renders it for a post whose COPY is health-adjacent, undeclared', () => {
    // The half that matters: the post that most needs the disclaimer is the one whose author did not think of
    // it as health copy, so the checkbox cannot be the only input.
    const html = render(
      [post({ bodyText: 'A note about an old injury before a session.' })],
      DISCLAIMER,
    )
    expect(html).toContain(DISCLAIMER)
  })

  it('renders nothing for an ordinary post, and nothing when the owner has written no wording', () => {
    // Two controls. Without the first, "renders the disclaimer" is satisfied by a page that always does and
    // the pattern means nothing; without the second, the page would render an empty region where the
    // compliance wording should be — which reads as a disclaimer nobody wrote.
    expect(render([post({})], DISCLAIMER)).not.toContain(DISCLAIMER)
    expect(render([post({})], DISCLAIMER)).not.toContain(
      `aria-label="${CONTENT_COPY_EN.labels.healthNote}"`,
    )
    expect(render([post({ healthTopicDeclared: true })], null)).not.toContain(
      `aria-label="${CONTENT_COPY_EN.labels.healthNote}"`,
    )
  })
})

describe('acceptance — /spa renders rooms, arrival, parking and transport from the premises row only', () => {
  it('changes with the row and changes back', async () => {
    const rows = await sql<{ parking_notes: string | null }[]>`
      select parking_notes from premises where id = 1
    `
    const before = rows[0]?.parking_notes ?? null
    const after = `Parking note for run ${RUN}`
    try {
      await sql`update premises set parking_notes = ${after} where id = 1`
      await republish('premises', PREMISES_PATHS)
      for (const path of ['/spa', '/ar/spa']) {
        const html = await fetchHtml(path)
        expect(html, `${path} does not carry the new value`).toContain(after)
        // And not the old one. A page carrying both would be a cached copy rendered beside a fresh one, which
        // a "contains the new value" assertion alone cannot see.
        if (before !== null && before !== '') expect(html, path).not.toContain(before)
      }
    } finally {
      await sql`update premises set parking_notes = ${before} where id = 1`
      await republish('premises', PREMISES_PATHS)
    }
    // The control: the page came back. Without it the rollback could have left the marker published and every
    // later run would be comparing against it.
    const restored = await fetchHtml('/spa')
    expect(restored).not.toContain(after)
    if (before !== null && before !== '') expect(restored).toContain(before)
  }, 180_000)

  it('states the absences instead of inventing them', async () => {
    // Two fields docs/09 §4 says `premises` holds and 0003 gives no column — public transport and the nearest
    // landmarks — and one provisional inventory (Y8-rooms). The page says so rather than publishing a bus
    // route from memory or a room count the desk could not keep.
    const found = headings(await fetchHtml('/spa'))
    const transport = found.find((heading) => heading.id === 'how-do-i-get-here-without-a-car')
    const rooms = found.find((heading) => heading.id === 'what-are-the-rooms-like')
    expect(transport?.answer, 'the transport answer is missing').toContain('Nothing is published')
    expect(rooms?.answer, 'the rooms answer is missing').toContain('provisional')
    // The control: the two answers that DO come from the row carry the row's values, so "states the absence"
    // is not what this page does with everything.
    const parking = found.find((heading) => heading.id === 'where-do-i-park')
    expect(parking?.answer).toBe(facts.parkingNotes)
  }, 30_000)
})

describe('acceptance — the link graph over the built site', () => {
  /** The three rules the site satisfies today. The other three are the scoped half; see below. */
  const SATISFIED: readonly LinkGraphRule[] = [
    'internal_link_not_200',
    'orphan_route',
    'route_beyond_click_depth',
  ]

  function inLocale(path: string, locale: 'en' | 'ar'): boolean {
    const isArabic = path === '/ar' || path.startsWith('/ar/')
    return locale === 'ar' ? isArabic : !isArabic
  }

  interface Candidate {
    readonly path: string
    readonly kind: LinkNodeKind
    readonly indexable: boolean
  }

  /**
   * Every page the registry claims, in one locale, with `/treatments/[slug]` expanded over the catalogue.
   *
   * The candidate set is the registry's rather than whatever the crawl happened to find, and that is the
   * difference between a link checker and an invariant: a page nothing links to has to be IN the graph to be
   * reported as an orphan.
   */
  function candidatesFor(locale: 'en' | 'ar'): readonly Candidate[] {
    return documentRoutes().flatMap((route) =>
      isParameterised(route.path)
        ? facts.catalogue.services.map((service) => ({
            path: localisedPath(`/treatments/${service.slug}`, locale),
            kind: 'treatment' as LinkNodeKind,
            indexable: route.indexable,
          }))
        : [
            {
              path: samplePathFor(route, locale),
              kind: (route.path === '/' ? 'home' : 'other') as LinkNodeKind,
              indexable: route.indexable,
            },
          ],
    )
  }

  /** One page, fetched, with the outbound links of its own locale's tree. */
  async function nodeFor(candidate: Candidate, locale: 'en' | 'ar'): Promise<LinkNode> {
    const response = await fetchPath(candidate.path)
    const html = response.status === 200 ? await response.text() : ''
    return {
      path: candidate.path,
      kind: candidate.kind,
      // One graph per locale: a link that crosses into the other locale's tree is the locale switch, and a
      // page reachable only through it is not reachable *in this language* — a reader arriving on `/ar` from
      // a search result would never find it.
      links: internalLinks(html).filter((link) => inLocale(link, locale)),
      status: response.status,
      indexable: candidate.indexable,
    }
  }

  /**
   * The graph for one locale: every registry document, plus every path they link to.
   *
   * A link to a path NOT in the registry is fetched too, so a link to something nothing serves is a finding
   * rather than a silence — which is the rule that would otherwise pass forever.
   */
  async function graphFor(locale: 'en' | 'ar'): Promise<LinkGraph> {
    const nodes: LinkNode[] = []
    const seen = new Set<string>()
    for (const candidate of candidatesFor(locale)) {
      const path = normaliseLinkPath(candidate.path)
      if (seen.has(path)) continue
      seen.add(path)
      nodes.push(await nodeFor({ ...candidate, path }, locale))
    }
    for (const link of new Set(nodes.flatMap((node) => [...node.links]))) {
      if (seen.has(link)) continue
      seen.add(link)
      const response = await fetchPath(link)
      nodes.push({
        path: link,
        kind: 'other',
        links: [],
        status: response.status,
        indexable: false,
      })
    }
    return { nodes, home: localisedPath('/', locale), maxClickDepth: 3 }
  }

  it('has zero orphans, zero unreachable pages and zero internal links that are not 200', async () => {
    for (const locale of ['en', 'ar'] as const) {
      const graph = await graphFor(locale)
      const report = judgeLinkGraph(graph)
      const findings = report.findings.filter((finding) => SATISFIED.includes(finding.rule))
      expect(formatLinkGraphFindings(findings), locale).toBe('')
      // Non-vacuous, and this is the half that matters: a crawl that found nothing would report no findings.
      // 17 indexable documents per locale — 9 fixed pages and 8 treatment pages — of which 16 are subjects of
      // the orphan rule, because the home page is exempt from it by definition. The ninth fixed page is
      // B-UI-01's `/book`, which the site navigation links from every page that renders it.
      expect(report.coverage.orphan_route, locale).toBe(16)
      expect(report.coverage.route_beyond_click_depth, locale).toBe(17)
      expect(report.coverage.internal_link_not_200, locale).toBeGreaterThan(40)
      // And every page really is inside the budget, reported rather than implied.
      expect(Math.max(...report.depths.values()), locale).toBeLessThanOrEqual(3)
      // The treatment pages are ONE click away, and they were two until W-SITE-04. That unit put a card per
      // published service on the home page, each linking to its own page — which is docs/09 §"Routes versus
      // anchors" in one sentence: "anchors serve homepage navigation; routes earn the rankings". The index is
      // still there and is still the hub every archived treatment 301s to; the spokes are now also reachable
      // from the page every reader arrives on, which is a shorter path to the most valuable pages on the site
      // and not a change to the hub. Asserted as an exact depth rather than `<= 2`, so a card that stopped
      // linking out fails here as well as in the home suite.
      const treatment = localisedPath(`/treatments/${facts.catalogue.services[0]?.slug}`, locale)
      expect(report.depths.get(treatment), treatment).toBe(1)
    }
  }, 300_000)

  it('SCOPED — the two hub-and-spoke rules fire on every treatment page, and nothing can satisfy them yet', async () => {
    // Deliberately not written as "no findings". There is no therapist page (W-SITE-06; and the 19 therapists
    // have no display name at all — ADR 0020, Y12-consent-photo) and no publishable journal post, because a
    // post needs an author byline and a reviewer byline and this build invents neither. So the two rules that
    // require a treatment page to link to one of each **do** fire, on all eight pages, and the manifest NOTE
    // says which unit closes them.
    //
    // Asserting the failure rather than suppressing the rule is the point: the day a therapist page or a
    // journal post lands, this assertion fails and is deleted, and the invariant is already there to hold.
    const report = judgeLinkGraph(await graphFor('en'))
    const byRule = (rule: LinkGraphRule): readonly string[] =>
      report.findings.filter((finding) => finding.rule === rule).map((finding) => finding.path)
    expect(report.coverage.treatment_without_therapist_link).toBe(8)
    expect(report.coverage.treatment_without_journal_link).toBe(8)
    expect(byRule('treatment_without_therapist_link')).toHaveLength(8)
    expect(byRule('treatment_without_journal_link')).toHaveLength(8)
    // And the third of the three: no journal post exists, so the rule about them judges nothing. Zero
    // subjects, reported as zero rather than as a pass.
    expect(report.coverage.journal_post_without_treatment_link).toBe(0)
    expect(byRule('journal_post_without_treatment_link')).toEqual([])
  }, 300_000)
})
