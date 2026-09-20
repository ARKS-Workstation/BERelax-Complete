import {
  assertCmsCopyCompliant,
  assertJournalPostPublishable,
  type CmsCopy,
  FAQ_ENTRIES,
  JOURNAL_POSTS,
  type JournalPostForPublication,
  PAGES,
} from '@berelax/cms'
import type { CompliancePolicy, FaqEntry } from '@berelax/core'
import { sql } from 'drizzle-orm'
import { getPayload, type Payload } from 'payload'
import config from '../../payload.config.ts'
import { richTextParagraphs, richTextToPlainText } from './rich-text.ts'

/**
 * The one Payload read path on a rendered route, and the reason it is shaped like this.
 *
 * ## The problem this module exists to solve
 *
 * W-SITE-05 recorded it exactly: *"there is no Payload read path on any rendered route: `push` is off under
 * `NODE_ENV=production`, so a `getPayload` read during `next build` would query tables the build cannot be
 * sure exist."* Both halves of that are true and neither is negotiable.
 *
 *   - **The tables may not exist at build time.** Payload's Postgres adapter creates them with drizzle-kit
 *     `push`, which `payload.config.ts` enables only when `NODE_ENV !== 'production'` — and `next build`
 *     forces `NODE_ENV=production`. So in a fresh environment the `payload` schema is empty when the build
 *     runs, and it is *materialised* by whatever runs Payload outside a build: the admin in development, the
 *     integration suite, or `payload migrate` as a deploy step. Measured rather than assumed: `getPayload`
 *     itself initialises happily in 45ms under build conditions, and the first `find` fails with
 *     `relation "payload.faq_entries" does not exist`.
 *   - **These routes must still be `isr`.** docs/09 §1 lists every one of them as ISR, and a dynamic render
 *     would put a database read in front of every crawler visit to a page that changes when an editor
 *     changes it.
 *
 * ## The resolution
 *
 * **Existence is checked before the read, and an absent table is an answer rather than an exception.**
 * `collectionAvailability` asks `information_schema` whether the table is there; when it is not, the page
 * renders its honest empty state — the same shape as a therapist with no name and a WhatsApp number nobody
 * has confirmed — and on-demand revalidation replaces it the moment content exists
 * (`src/revalidate/content.ts`). So the build never fails for want of a CMS schema, and it never bakes a
 * page claiming the business has no FAQ either: it bakes a page that says nothing is published yet.
 *
 * The existence check is a **separate query** from the read, and that is the decision rather than the
 * shortcut. Wrapping the read in a try/catch and matching "does not exist" on the message would also
 * swallow a deadlock, a permission error and a syntax mistake, and report all of them as "no content" —
 * `apps/web/src/payload/future-bookings.ts` records the same reasoning for the same trade, and this follows
 * it deliberately so there is one pattern for "the table this rule needs is not in this database yet".
 *
 * ## Why the lint is here
 *
 * Because this is the last thing that runs before CMS copy becomes public bytes, and because the acceptance
 * criterion is that a post containing a banned claim **fails the build**. A page cannot fail a build; a read
 * during `generateStaticParams`/render can, and does: `assertCmsCopyCompliant` throws, `next build` reports
 * it with the rule name, and nothing is published. It is the second gate — the Payload hook
 * (`src/collections/journal-posts.ts`) refuses the publish in the first place — and the second gate exists
 * because a row can arrive through a path that never ran a hook: a `psql` session, a restored dump, a
 * migration. `publishLlmsTxt` lints a file built from rows it trusts for the same reason.
 */

/** Whether the CMS can be read at all, and why not when it cannot. */
export type CmsAvailability =
  | { readonly kind: 'ready' }
  | { readonly kind: 'unavailable'; readonly reason: string }

/** The collections these routes read, by the table name the `payload` schema gives them. */
const COLLECTION_TABLES = {
  faq: FAQ_ENTRIES.slug,
  journal: JOURNAL_POSTS.slug,
  pages: PAGES.slug,
} as const

/**
 * One Payload instance per process, built on first use.
 *
 * Lazy for the reason `src/facts/runtime.ts` gives about the database connection: `next build` imports every
 * route module to collect its exports, and anything built at module scope runs on a machine that may have no
 * database. `getPayload` memoises internally as well, but the null-on-failure branch is this module's: a
 * build with no `DATABASE_URL` must render the empty state rather than fail, which is the same fail-soft
 * decision `readPageFacts` makes and for the same reason — a page has other content.
 */
let instance: Promise<Payload | null> | undefined

export function cmsPayload(): Promise<Payload | null> {
  if (instance !== undefined) return instance
  instance = getPayload({ config }).catch(() => null)
  return instance
}

/** Forgets the memoised instance. For a test that has to prove the fallback path, and nothing else. */
export function resetCmsPayloadForTests(): void {
  instance = undefined
}

interface ExecutingAdapter {
  readonly drizzle: unknown
  readonly execute: (args: { db?: unknown; drizzle?: unknown; sql?: unknown }) => Promise<unknown>
}

function adapterOf(payload: Payload): ExecutingAdapter | null {
  const candidate = payload.db as unknown as Partial<ExecutingAdapter>
  return typeof candidate.execute === 'function' ? (candidate as ExecutingAdapter) : null
}

function firstRow(result: unknown): Readonly<Record<string, unknown>> | null {
  const rows = (result as { readonly rows?: unknown })?.rows
  if (!Array.isArray(rows) || rows.length === 0) return null
  const row = rows[0]
  return row !== null && typeof row === 'object' ? (row as Readonly<Record<string, unknown>>) : null
}

/**
 * Is this collection's table in the `payload` schema of this database?
 *
 * The schema name is Payload's own (`schemaName: 'payload'` in `payload.config.ts`, so `pnpm db:drift` does
 * not compare Payload's tables against a Drizzle mirror) and it is read off the adapter rather than spelled
 * again here, so a change to that setting cannot leave this probe asking about the wrong schema.
 */
export async function collectionAvailability(
  payload: Payload,
  table: string,
): Promise<CmsAvailability> {
  const adapter = adapterOf(payload)
  if (adapter === null) {
    return { kind: 'unavailable', reason: 'the Payload adapter exposes no way to run a query' }
  }
  const schema = (payload.db as unknown as { readonly schemaName?: unknown }).schemaName
  const schemaName = typeof schema === 'string' && schema !== '' ? schema : 'public'
  const row = firstRow(
    await adapter.execute({
      db: adapter.drizzle,
      drizzle: adapter.drizzle,
      sql: sql`
        select count(*)::int as n
        from information_schema.tables
        where table_schema = ${schemaName} and table_name = ${table}
      `,
    }),
  )
  if (Number(row?.['n'] ?? 0) > 0) return { kind: 'ready' }
  return {
    kind: 'unavailable',
    reason:
      `${schemaName}.${table} does not exist in this database. Payload creates its tables with ` +
      'drizzle-kit push, which is off under NODE_ENV=production — so a build in a fresh environment ' +
      'sees no CMS schema and this page renders its empty state until one exists.',
  }
}

/** What a CMS read answered: the rows, and whether there was anything to read them from. */
export interface CmsRead<T> {
  readonly availability: CmsAvailability
  readonly rows: readonly T[]
}

const unavailable = <T>(reason: string): CmsRead<T> => ({
  availability: { kind: 'unavailable', reason },
  rows: [],
})

/**
 * Every published row of one collection, or an empty read with the reason.
 *
 * `_status: 'published'` rather than Payload's `draft: false`, and the difference is not cosmetic: a document
 * that has only ever been saved as a draft lives in the collection's own table with `_status = 'draft'`, so
 * a read without this filter serves unpublished copy on a public page. Measured against a real database
 * with one draft and one published row.
 */
async function publishedRows(
  collection: string,
  table: string,
  sort: string,
): Promise<CmsRead<Readonly<Record<string, unknown>>>> {
  const payload = await cmsPayload()
  if (payload === null) {
    return unavailable('Payload could not be initialised; the database may be unreachable')
  }
  const availability = await collectionAvailability(payload, table)
  if (availability.kind === 'unavailable') return { availability, rows: [] }
  const result = await payload.find({
    collection: collection as never,
    where: { _status: { equals: 'published' } },
    sort,
    // A cap rather than `0`: an unbounded read on a public page is a page whose render time is whatever an
    // editor typed. 200 is far above the size of any of these collections and is a number a reader can see.
    limit: 200,
    depth: 0,
  })
  return { availability, rows: result.docs as Readonly<Record<string, unknown>>[] }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const nullableText = (value: unknown): string | null => {
  const found = text(value).trim()
  return found === '' ? null : found
}

/**
 * The FAQ, as `@berelax/core`'s `FaqEntry` — which is what `faqPageNode` takes.
 *
 * One shape for the page and the schema block, deliberately: the acceptance criterion is that *"/faq and the
 * FAQPage schema derive from the same faq_entries rows: question and answer text and entry count are
 * asserted equal"*, and the strongest form of that is not an assertion at all — it is one read, one array,
 * handed to the body and to `pageGraph`. The assertion then has something real to check rather than two
 * code paths to compare.
 */
export async function readFaqEntries(): Promise<CmsRead<FaqEntry>> {
  // `_order` is Payload's own orderable column, which drag-and-drop in the admin writes. `FAQ_ENTRIES` is
  // `orderable: true` precisely so the editorial order is not an integer two entries can share.
  const read = await publishedRows(FAQ_ENTRIES.slug, COLLECTION_TABLES.faq, '_order')
  return {
    availability: read.availability,
    rows: read.rows.map((row) => ({
      question: text(row['question']),
      answer: richTextToPlainText(row['answer']),
      topic: text(row['topic']),
    })),
  }
}

/** One journal post, as the index and the publication lint need it. */
export interface JournalPost extends JournalPostForPublication {
  /** The body as paragraphs, for the page. The lint reads `bodyText`. */
  readonly paragraphs: readonly string[]
}

/** Every published post, newest first. */
export async function readJournalPosts(): Promise<CmsRead<JournalPost>> {
  const read = await publishedRows(JOURNAL_POSTS.slug, COLLECTION_TABLES.journal, '-published_on')
  return {
    availability: read.availability,
    rows: read.rows.map((row) => ({
      slug: text(row['slug']),
      title: text(row['title']),
      standfirst: nullableText(row['standfirst']),
      bodyText: richTextToPlainText(row['body']),
      paragraphs: richTextParagraphs(row['body']),
      byline: nullableText(row['byline']),
      reviewedBy: nullableText(row['reviewed_by']),
      publishedOn: nullableText(row['published_on']),
      healthTopicDeclared: row['health_topic'] === true,
    })),
  }
}

/** An editorial page — `/about`, and the legal set when one exists. */
export interface EditorialPage {
  readonly slug: string
  readonly title: string
  readonly lede: string | null
  readonly paragraphs: readonly string[]
  readonly bodyText: string
  readonly seoTitle: string | null
  readonly seoDescription: string | null
}

/** Every published editorial page, by slug. */
export async function readEditorialPages(): Promise<CmsRead<EditorialPage>> {
  const read = await publishedRows(PAGES.slug, COLLECTION_TABLES.pages, 'slug')
  return {
    availability: read.availability,
    rows: read.rows.map((row) => ({
      slug: text(row['slug']),
      title: text(row['title']),
      lede: nullableText(row['lede']),
      paragraphs: richTextParagraphs(row['body']),
      bodyText: richTextToPlainText(row['body']),
      seoTitle: nullableText(row['seo_title']),
      seoDescription: nullableText(row['seo_description']),
    })),
  }
}

/**
 * The medical disclaimer in force, or null.
 *
 * `compliance_notices` is the owner-only global (`settings:write_compliance`, the owner alone in the F07
 * matrix) and it is unwritten today: Payload answers `{ _status: 'draft' }` with no fields at all, which is
 * why this returns null rather than throwing. Null is what makes health-adjacent copy unpublishable, which
 * is the fail-closed direction — inventing the wording here would be a licensing act taken by a template.
 */
export async function readMedicalDisclaimer(): Promise<string | null> {
  const payload = await cmsPayload()
  if (payload === null) return null
  try {
    const global = await payload.findGlobal({ slug: 'compliance_notices' as never, depth: 0 })
    const value = (global as Readonly<Record<string, unknown>>)['medical_disclaimer']
    const flattened = richTextToPlainText(value).trim()
    return flattened === '' ? null : flattened
  } catch {
    // The global's table is created by the same push as the collections', so an absent one is the same
    // "no CMS schema yet" state the collections report. Null, not a throw: see the module header.
    return null
  }
}

/**
 * Every published post, checked against the publication lint, or a throw naming the rule.
 *
 * Throws rather than filtering, which is the decision the acceptance criterion forces: *"a journal post
 * without an author byline, a reviewer byline or a date fails publication with a named error"*. Filtering
 * would make an unpublishable post disappear quietly from the index — the page would render, the post would
 * be `_status: 'published'` in the admin, and nobody would be told which of the two is wrong.
 */
export async function assertPostsPublishable(
  posts: readonly JournalPost[],
  disclaimer: string | null,
): Promise<void> {
  for (const post of posts) assertJournalPostPublishable(post, { disclaimer })
  await Promise.resolve()
}

/** Every piece of CMS copy a page is about to render, named by where it came from. */
export function cmsCopyOf(input: {
  readonly faq?: readonly FaqEntry[]
  readonly posts?: readonly JournalPost[]
  readonly pages?: readonly EditorialPage[]
}): readonly CmsCopy[] {
  const copy: CmsCopy[] = []
  for (const entry of input.faq ?? []) {
    copy.push({ where: `${FAQ_ENTRIES.slug}/${entry.question}`, text: entry.question })
    copy.push({ where: `${FAQ_ENTRIES.slug}/${entry.question}`, text: entry.answer })
  }
  for (const post of input.posts ?? []) {
    copy.push({
      where: `${JOURNAL_POSTS.slug}/${post.slug}`,
      text: [post.title, post.standfirst ?? '', post.bodyText].join('\n'),
    })
  }
  for (const page of input.pages ?? []) {
    copy.push({
      where: `${PAGES.slug}/${page.slug}`,
      text: [page.title, page.lede ?? '', page.bodyText].join('\n'),
    })
  }
  return copy
}

/** Throws unless every piece of CMS copy about to be rendered passes the banned-claims lint. */
export function assertRenderedCopyCompliant(
  input: Parameters<typeof cmsCopyOf>[0],
  policy: CompliancePolicy,
): void {
  assertCmsCopyCompliant(cmsCopyOf(input), policy)
}
