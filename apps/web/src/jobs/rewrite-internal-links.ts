/**
 * The internal-link rewrite a therapist's departure triggers.
 *
 * docs/09 §5's interconnection map, one row: *"Archive a therapist → 301 to `/therapists` · removed from
 * availability · future appointments flagged for reassignment · **internal links rewritten**"*. The 301 is
 * `archiveTherapist`'s and the availability is the solver's. This is the fourth clause, and it exists
 * because the 301 alone is not enough: every internal link to a retired therapist costs a reader and a
 * crawler one redirect, and a redirect from a page this site controls is a page this site is pointing at
 * the wrong URL. docs/09 §"Routes versus anchors" is about earning rankings with real documents; an
 * internal link that 301s spends the crawl budget that would have fetched one.
 *
 * ## What it rewrites, and what it deliberately does not
 *
 * **It rewrites prose.** CMS rich text and plain-text fields are the only internal links a person wrote by
 * hand, so they are the only ones that can go stale. The therapist grid, the breadcrumb and the navigation
 * are all DERIVED from the roster — `therapistIndexCards` gives a retired therapist no card at all — so
 * they are correct on the next request with nothing to rewrite.
 *
 * **It does not touch `redirect_map`.** The map is the record of what moved; rewriting a link is not a
 * second redirect, and a job that edited the map would be undoing `archiveTherapist`'s work.
 *
 * **It does not touch a review.** docs/09 §2: a departing therapist's *"reviews stay attributed to the
 * business"*. `google_reviews` carries no therapist reference at all, which is what makes that true by
 * construction rather than by this job remembering it — and `therapists.itest.ts` asserts the row count is
 * unchanged, which is the control for a job that decided to be thorough.
 *
 * ## Why it reports what remains rather than returning void
 *
 * The acceptance line is *"leaves zero remaining links to them"*, and a job that returns nothing can only
 * be checked by looking for links again with a second implementation of "what is a link to this page". So
 * the job counts what it rewrote AND re-scans with the same matcher, and `remaining` is what the test
 * asserts. A non-zero `remaining` names the documents, because the realistic cause is a field this job
 * does not know about.
 */
import { AppError } from '@berelax/shared'

/** A document whose text may hold an internal link. The id is for the report, never for display. */
export interface LinkBearingDocument {
  readonly collection: string
  readonly id: string
  readonly field: string
  readonly text: string
}

/** The reader and the writer, injected so the decision is testable without Payload or a database. */
export interface RewriteDeps {
  readonly read: () => Promise<readonly LinkBearingDocument[]>
  readonly write: (document: LinkBearingDocument, text: string) => Promise<void>
}

/** Where one rewrite happened. Never the text, which would put published copy in a job report. */
export interface RewriteSite {
  readonly collection: string
  readonly id: string
  readonly field: string
}

export interface RewriteReport {
  /** How many documents were examined. Zero is legitimate and has to be visible. */
  readonly examined: number
  readonly rewritten: readonly RewriteSite[]
  /** Documents that STILL hold a link to a retired path after the rewrite. Must be empty. */
  readonly remaining: readonly RewriteSite[]
  /** How many link occurrences were replaced in total. */
  readonly replacements: number
}

/**
 * Every occurrence of a retired path in one string, replaced by its target.
 *
 * The match is anchored on a path boundary — the end of the string, a quote, whitespace, `<`, `?` or `#` —
 * and NOT a bare `includes`. Without the boundary, retiring `/therapists/ana` would rewrite every link to
 * `/therapists/anabel`, and the symptom would be a 301 on a page nobody touched. A query string and a
 * fragment survive, because a link carrying `?utm_source=` is how a campaign is attributed and dropping it
 * turns a tracked visit into direct traffic silently.
 */
export function rewritePathsIn(
  text: string,
  retired: ReadonlyMap<string, string>,
): { readonly text: string; readonly replacements: number } {
  let result = text
  let replacements = 0
  for (const [from, to] of retired) {
    if (from === to) {
      throw new AppError(
        'validation',
        `the rewrite map sends ${from} to itself, which is a rewrite that can never finish`,
        { details: { rule: 'rewrite_map_is_not_identity', path: from } },
      )
    }
    // Escaped, because a path is data: a slug cannot contain a regex metacharacter today
    // (`employee_public_slug_shape`), and relying on that from here would make a schema relaxation a
    // surprise in a job nobody was looking at.
    const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`${escaped}(?=$|[\\s"'<>?#\\\\])`, 'g')
    const found = result.match(pattern)
    if (found !== null) {
      replacements += found.length
      result = result.replace(pattern, to)
    }
  }
  return { text: result, replacements }
}

/**
 * Rewrite every internal link to a retired therapist, then prove none is left.
 *
 * The re-scan uses the SAME matcher as the rewrite, which is the point: a second implementation of "what
 * counts as a link to this page" is a second answer, and the day they disagreed the report would say zero
 * while the links were still there.
 */
export async function rewriteInternalLinks(
  retired: ReadonlyMap<string, string>,
  deps: RewriteDeps,
): Promise<RewriteReport> {
  const documents = await deps.read()
  const rewritten: RewriteSite[] = []
  const remaining: RewriteSite[] = []
  let replacements = 0
  for (const document of documents) {
    const site = { collection: document.collection, id: document.id, field: document.field }
    const result = rewritePathsIn(document.text, retired)
    if (result.replacements > 0) {
      await deps.write(document, result.text)
      rewritten.push(site)
      replacements += result.replacements
    }
    // The re-scan is over what was WRITTEN rather than over what was read: a rewrite that produced a
    // string still containing a retired path — which a wrong boundary would — has to show up here.
    if (rewritePathsIn(result.text, retired).replacements > 0) remaining.push(site)
  }
  return { examined: documents.length, rewritten, remaining, replacements }
}
