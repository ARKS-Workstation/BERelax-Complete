import type { Sql } from '../connection.ts'

/**
 * The write and the read for `seo_suggestion_candidate` (migration 0057).
 *
 * ## What is deliberately not here
 *
 * No screening. The target allowlist and the banned-claim filter are `packages/core/src/seo` —
 * `target-allowlist.ts` and `candidate-screen.ts` — and `packages/db` may not import `packages/core` (the
 * dependency runs core ← db). So the caller screens and then writes, which is the arrangement
 * `seo-warehouse.ts` already uses for the URL-inspection budget and which the module boundary requires.
 *
 * That is not a hole. The database refuses a denied target itself, by CHECK, whatever the caller did or
 * forgot: `seo_suggestion_candidate_target_kind_allowlisted` and
 * `seo_suggestion_candidate_target_ref_is_not_a_machine_directive`. This module does not catch either, and
 * that is the point — a repository that swallowed a constraint violation and returned a count would turn the
 * one enforcement a bypassing caller cannot avoid into a silent drop.
 *
 * ## Why the insert reports what it SKIPPED
 *
 * `on conflict do nothing` against `seo_suggestion_candidate_identity` is what makes a re-run of the same
 * analysis over the same window idempotent rather than a second copy of every finding. The number skipped is
 * returned rather than discarded, because "the pass found nothing new" and "the pass found nothing" are
 * different facts and a single count cannot tell them apart — the same argument migration 0042 makes for
 * `seo_gsc_snapshot` existing at all.
 */

/** The constraint names a caller or a test names when it asserts a refusal. */
export const SEO_CANDIDATE_CONSTRAINTS = Object.freeze({
  targetKindAllowlisted: 'seo_suggestion_candidate_target_kind_allowlisted',
  targetRefIsNotAMachineDirective: 'seo_suggestion_candidate_target_ref_is_not_a_machine_directive',
  findingKind: 'seo_suggestion_candidate_finding_kind_check',
  identity: 'seo_suggestion_candidate_identity',
})

/** One candidate to write. Already screened by the caller; the CHECKs are the backstop. */
export interface SuggestionCandidateInsert {
  /** The `agent_run` it came from, or null. No foreign key — see migration 0057. */
  readonly runId: string | null
  readonly siteUrl: string
  readonly findingKind: string
  readonly targetKind: string
  /** A locator. Never the copy a suggestion proposes. */
  readonly targetRef: string
  readonly query: string | null
}

/** One candidate as it comes back. */
export interface SuggestionCandidateRow extends SuggestionCandidateInsert {
  readonly candidateId: string
  readonly createdAt: Date
}

/** What one write did. Both halves, because a silent skip is the failure mode. */
export interface SuggestionCandidateWrite {
  readonly inserted: number
  readonly skipped: number
}

/**
 * Writes a screened batch, skipping candidates the identity constraint already holds.
 *
 * One statement per batch rather than per row: nine hundred candidates is not a plausible night, but a
 * per-row round trip inside an agent run is the shape that becomes one when the site grows.
 */
export async function insertSuggestionCandidates(
  sql: Sql,
  candidates: readonly SuggestionCandidateInsert[],
): Promise<SuggestionCandidateWrite> {
  if (candidates.length === 0) return { inserted: 0, skipped: 0 }
  const values = candidates.map((candidate) => ({
    run_id: candidate.runId,
    site_url: candidate.siteUrl,
    finding_kind: candidate.findingKind,
    target_kind: candidate.targetKind,
    target_ref: candidate.targetRef,
    query: candidate.query,
  }))
  const written = (await sql`
    insert into seo_suggestion_candidate ${sql(
      values,
      'run_id',
      'site_url',
      'finding_kind',
      'target_kind',
      'target_ref',
      'query',
    )}
    on conflict on constraint seo_suggestion_candidate_identity do nothing
    returning candidate_id::text as candidate_id
  `) as unknown as { candidate_id: string }[]
  return { inserted: written.length, skipped: candidates.length - written.length }
}

/**
 * Every candidate for one property, newest first.
 *
 * Uncapped on purpose. A `limit` belongs on the panel that renders a page of these, and not here: the brief's
 * rule 12 records what a capped reader does to a count — `settingHistory`'s limit made three recorded changes
 * read as zero once the table passed 500 rows — and the assertion this read exists for is "no persisted row
 * carries a banned term", which is a statement about every row.
 */
export async function readSuggestionCandidates(
  sql: Sql,
  siteUrl: string,
): Promise<readonly SuggestionCandidateRow[]> {
  const rows = (await sql`
    select candidate_id::text as candidate_id,
           run_id::text       as run_id,
           site_url,
           finding_kind,
           target_kind,
           target_ref,
           query,
           created_at
    from seo_suggestion_candidate
    where site_url = ${siteUrl}
    order by created_at desc, candidate_id desc
  `) as unknown as {
    candidate_id: string
    run_id: string | null
    site_url: string
    finding_kind: string
    target_kind: string
    target_ref: string
    query: string | null
    created_at: Date
  }[]
  return rows.map((row) => ({
    candidateId: row.candidate_id,
    runId: row.run_id,
    siteUrl: row.site_url,
    findingKind: row.finding_kind,
    targetKind: row.target_kind,
    targetRef: row.target_ref,
    query: row.query,
    createdAt: row.created_at,
  }))
}

/**
 * How many persisted candidates for one property have a QUERY mentioning a phrase, counted IN SQL.
 *
 * In SQL and not in JavaScript over a read, for the reason the read above gives: the claim being proved is
 * about every row in the table, and a count taken through anything that pages is a count that pins at the
 * page size. The comparison is a case-insensitive substring, deliberately BROADER than `containsPhrase` —
 * the assertion it serves is "the term is not in there at all", and a comparison narrower than the filter's
 * would be the assertion agreeing with itself.
 *
 * `target_ref` is deliberately NOT scanned, and the reason is the same one that keeps it out of the ingest
 * screen: a locator is not a claim, and this site's locators live under `/treatments/`, which tokenises to a
 * word the profile bans. A count that included the locator would report every legitimate candidate for every
 * treatment page as a banned-term row.
 */
export async function countCandidatesMentioning(
  sql: Sql,
  args: { readonly siteUrl: string; readonly phrase: string },
): Promise<number> {
  const rows = (await sql`
    select count(*)::int as n
    from seo_suggestion_candidate
    where site_url = ${args.siteUrl}
      and coalesce(query, '') ilike ${`%${args.phrase}%`}
  `) as unknown as { n: number }[]
  return rows[0]?.n ?? 0
}
