import {
  agentPrincipal,
  type CompliancePolicy,
  CTR_OUTLIER_POSITION_WINDOW,
  ctrOutliers,
  DENIED_SUGGESTION_TARGET_KINDS,
  deniedTargetRefMarker,
  PrincipalDenied,
  SEO_AGENT_PRINCIPAL,
  type SeoQueryRow,
  SUGGESTION_TARGET_KINDS,
  type SuggestionCandidateProposal,
  staffPrincipal,
  TARGET_REF_SPECIMENS,
} from '@berelax/core'
import {
  countCandidatesMentioning,
  createConnection,
  insertSuggestionCandidates,
  readSuggestionCandidates,
  SEO_CANDIDATE_CONSTRAINTS,
  type Sql,
  upsertGscDailyRows,
} from '@berelax/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ingestSuggestionCandidates, type SeoIngestLogLine } from './candidate-ingest.ts'

/**
 * G-SEO-02 against a real PostgreSQL: the target allowlist the database enforces, and the banned term that
 * never reaches a row.
 *
 * The allowlist is declared in `@berelax/core` and enforced by CHECK constraints in `@berelax/db`'s migration
 * 0057, and `db` may not import `core` — the dependency runs the other way and `pnpm boundaries` enforces it.
 * So the two implementations of one rule can only be held to each other from somewhere that may depend on
 * both, and the pairing IS the thing under test: a test that asserted only the code would prove nothing about
 * a `psql` session, and one that asserted only the constraint would prove nothing about the message an
 * operator reads.
 *
 * It sits here rather than in `packages/fixtures` — the usual home for a core-plus-db pairing — because the
 * third participant is this package: `ingestSuggestionCandidates` is the boundary that composes the screen
 * and the write, and `packages/fixtures` does not depend on `@berelax/google`. Adding that dependency for one
 * test would widen the graph to host a file whose subject already lives here, beside
 * `nightly-pass.itest.ts`, which drives `@berelax/db` from this package for the same reason.
 *
 * ## Why the term is counted in SQL
 *
 * "A banned medical term never appears in any persisted candidate row" is a statement about every row in the
 * table. The brief's rule 12 records what happens to a claim like that when it is read through anything that
 * pages: `settingHistory`'s limit made three recorded changes read as zero once the table passed 500 rows.
 * So the count is `countCandidatesMentioning`, which is `count(*)` in the database.
 *
 * ## Isolation
 *
 * Every row this file writes carries its own `site_url`, and only those rows are removed. The suite runs
 * sequentially against one database and earlier files leave rows behind (brief rule 12); a `delete from
 * seo_suggestion_candidate` with no predicate would be this file assuming it is the only writer, which is the
 * assumption that fails on somebody else's branch.
 */
const DATABASE_URL = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL'] ?? ''

/** This file's own property. A domain property and a URL-prefix property are two datasets (docs/10 §2). */
const SITE = 'sc-domain:gseo02-cage.example'
const PAGE = 'https://gseo02-cage.example/treatments/hot-oil-massage'
const OTHER_PAGE = 'https://gseo02-cage.example/spa'

let sql: Sql
/** The profile in force, read from the database rather than written here. See the header. */
let policy: CompliancePolicy
/** The first banned term the profile in force carries. Asserted non-empty before it is used. */
let bannedTerm: string

const seoAgent = () => {
  const principal = agentPrincipal(SEO_AGENT_PRINCIPAL)
  if (principal === null) throw new Error('the seo_agent principal is not declared in the registry')
  return principal
}

/** The constraint a driver error names, in either of the spellings the drivers use. */
const constraintOf = (error: unknown): string =>
  String(
    (error as { constraint_name?: string; constraint?: string } | null)?.constraint_name ??
      (error as { constraint?: string } | null)?.constraint ??
      (error as Error)?.message ??
      '',
  )

/** Attempts one insert and returns the error, or throws if the insert unexpectedly succeeded. */
async function refusedInsert(candidate: {
  readonly targetKind: string
  readonly targetRef: string
}): Promise<unknown> {
  try {
    await insertSuggestionCandidates(sql, [
      {
        runId: null,
        siteUrl: SITE,
        findingKind: 'ctr_outlier',
        targetKind: candidate.targetKind,
        targetRef: candidate.targetRef,
        query: 'hot oil massage abu dhabi',
      },
    ])
  } catch (error) {
    return error
  }
  throw new Error(
    `the database ACCEPTED a suggestion targeting ${candidate.targetKind} ${candidate.targetRef}`,
  )
}

const capturingLogger = () => {
  const lines: SeoIngestLogLine[] = []
  return { lines, logger: { log: (line: SeoIngestLogLine) => lines.push(line) } }
}

beforeAll(async () => {
  sql = createConnection({ url: DATABASE_URL, max: 4 })
  const [row] = (await sql`
    select banned_claim_terms as banned, permitted_public_titles as titles,
           medical_claims_permitted as medical
    from regulatory_profile where superseded_at is null
  `) as unknown as { banned: string[]; titles: string[]; medical: boolean }[]
  if (row === undefined) throw new Error('no regulatory profile in force')
  policy = {
    bannedClaimTerms: row.banned,
    permittedPublicTitles: row.titles,
    medicalClaimsPermitted: row.medical,
  }
  bannedTerm = policy.bannedClaimTerms[0] ?? ''
})

afterAll(async () => {
  await sql`delete from seo_suggestion_candidate where site_url = ${SITE}`
  await sql`delete from seo_gsc_daily where site_url = ${SITE}`
  await sql.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql`delete from seo_suggestion_candidate where site_url = ${SITE}`
})

describe('acceptance — the target allowlist is enforced in the database', () => {
  it('refuses all four denied target kinds by CHECK, naming the constraint', async () => {
    // `DENIED_SUGGESTION_TARGET_KINDS` is the criterion's four, by name: robots.txt, a canonical, a redirect
    // rule and a noindex directive.
    expect(DENIED_SUGGESTION_TARGET_KINDS).toHaveLength(4)
    for (const kind of DENIED_SUGGESTION_TARGET_KINDS) {
      const error = await refusedInsert({ targetKind: kind, targetRef: '/spa#title' })
      expect(constraintOf(error), kind).toContain(SEO_CANDIDATE_CONSTRAINTS.targetKindAllowlisted)
    }
  })

  it('refuses the same four surfaces wearing an ALLOWLISTED kind, by the other constraint', async () => {
    // The interesting half. `target_kind: 'body_copy'` with `target_ref: '/robots.txt'` is the forbidden edit
    // with an honest-looking label on it, and the kind allowlist alone cannot see it.
    const disguised = [
      { targetKind: 'body_copy', targetRef: '/robots.txt' },
      { targetKind: 'page_title', targetRef: 'link[rel=canonical]' },
      { targetKind: 'heading', targetRef: 'redirect_map:/old-price-list' },
      { targetKind: 'meta_description', targetRef: 'meta[name=robots][content=noindex]' },
    ]
    for (const candidate of disguised) {
      const error = await refusedInsert(candidate)
      expect(constraintOf(error), candidate.targetRef).toContain(
        SEO_CANDIDATE_CONSTRAINTS.targetRefIsNotAMachineDirective,
      )
    }
  })

  it('the control: every allowlisted kind with an ordinary locator is ACCEPTED', async () => {
    // Without this, the two cases above are satisfied by a table that refuses every insert — which would
    // report a perfect cage around an agent that can do nothing at all.
    const written = await insertSuggestionCandidates(
      sql,
      SUGGESTION_TARGET_KINDS.map((kind) => ({
        runId: null,
        siteUrl: SITE,
        findingKind: 'ctr_outlier' as const,
        targetKind: kind,
        targetRef: `${PAGE}#${kind}`,
        query: 'hot oil massage abu dhabi',
      })),
    )
    expect(written.inserted).toBe(SUGGESTION_TARGET_KINDS.length)
    expect(await readSuggestionCandidates(sql, SITE)).toHaveLength(SUGGESTION_TARGET_KINDS.length)
  })

  it('refuses a finding kind outside the closed set, so a new analysis is a migration', async () => {
    let caught: unknown
    try {
      await insertSuggestionCandidates(sql, [
        {
          runId: null,
          siteUrl: SITE,
          findingKind: 'llm_hunch',
          targetKind: 'page_title',
          targetRef: `${PAGE}#title`,
          query: null,
        },
      ])
    } catch (error) {
      caught = error
    }
    expect(constraintOf(caught)).toContain(SEO_CANDIDATE_CONSTRAINTS.findingKind)
  })

  it('is idempotent on a re-run, and reports the rows it skipped rather than losing them', async () => {
    const candidate = {
      runId: null,
      siteUrl: SITE,
      findingKind: 'cannibalisation' as const,
      targetKind: 'heading',
      targetRef: `${OTHER_PAGE}#h2-1`,
      query: null,
    }
    expect((await insertSuggestionCandidates(sql, [candidate])).inserted).toBe(1)
    const again = await insertSuggestionCandidates(sql, [candidate])
    // NULLS NOT DISTINCT on the identity constraint is what makes this 0 rather than 1: `query` is null for a
    // whole class of findings, and under the default NULLS DISTINCT every re-run would add another copy.
    expect(again.inserted).toBe(0)
    expect(again.skipped).toBe(1)
    expect(await readSuggestionCandidates(sql, SITE)).toHaveLength(1)
  })
})

describe('the SQL predicate and the core allowlist agree, specimen by specimen', () => {
  it('agrees on every specimen, in both directions', async () => {
    // Two implementations of one rule is one rule plus a future disagreement (0026's `is_placeholder_text`
    // records the same argument). This is what holds them together.
    for (const specimen of TARGET_REF_SPECIMENS) {
      const [row] = (await sql`
        select seo_target_ref_is_denied(${specimen.ref}) as denied
      `) as unknown as { denied: boolean }[]
      expect(row?.denied, `SQL disagrees about ${specimen.ref}`).toBe(specimen.marker !== null)
      expect(deniedTargetRefMarker(specimen.ref) !== null, specimen.ref).toBe(row?.denied)
    }
  })

  it('the corpus carries both outcomes, so agreement is not two functions refusing everything', async () => {
    const denied = TARGET_REF_SPECIMENS.filter((specimen) => specimen.marker !== null)
    const allowed = TARGET_REF_SPECIMENS.filter((specimen) => specimen.marker === null)
    expect(denied.length).toBeGreaterThanOrEqual(6)
    expect(allowed.length).toBeGreaterThanOrEqual(6)
    // And the SQL function really does answer both ways, asserted against the database rather than inferred
    // from the corpus.
    const [yes] =
      (await sql`select seo_target_ref_is_denied('/robots.txt') as denied`) as unknown as {
        denied: boolean
      }[]
    const [no] =
      (await sql`select seo_target_ref_is_denied(${`${PAGE}#title`}) as denied`) as unknown as {
        denied: boolean
      }[]
    expect(yes?.denied).toBe(true)
    expect(no?.denied).toBe(false)
  })

  it('refuses a NULL rather than passing it, because a NULL CHECK expression is satisfied', async () => {
    // 0026's lesson, restated here because it is the failure that reads in the schema as though it did not
    // exist: a STRICT function returns NULL for NULL, a CHECK whose expression is NULL passes, and the
    // constraint would accept the value it exists to refuse.
    const [row] = (await sql`
      select seo_target_ref_is_denied(null) as denied
    `) as unknown as { denied: boolean }[]
    expect(row?.denied).toBe(true)
  })
})

describe('acceptance — the banned term in the GSC fixture never reaches a persisted row', () => {
  /** The warehouse fixture: three (query, page) pairs, one of which asserts a banned claim. */
  async function seedWarehouse(): Promise<readonly SeoQueryRow[]> {
    const base = { siteUrl: SITE, date: '2026-09-14', device: 'DESKTOP', country: 'are' }
    const rows = [
      // The banned one. The query is built from the profile's OWN first term, so the fixture cannot drift
      // away from the list it is supposed to be caught by.
      {
        ...base,
        page: PAGE,
        query: `${bannedTerm} massage abu dhabi`,
        clicks: 1,
        impressions: 900,
        avgPositionCenti: 800,
      },
      {
        ...base,
        page: PAGE,
        query: 'hot oil massage abu dhabi',
        clicks: 2,
        impressions: 1000,
        avgPositionCenti: 850,
      },
      {
        ...base,
        page: OTHER_PAGE,
        query: 'spa abu dhabi al zahiyah',
        clicks: 60,
        impressions: 1000,
        avgPositionCenti: 820,
      },
      {
        ...base,
        page: OTHER_PAGE,
        query: 'best spa abu dhabi',
        clicks: 55,
        impressions: 1000,
        avgPositionCenti: 830,
      },
    ]
    await upsertGscDailyRows(sql, rows)
    const read = (await sql`
      select page, query, clicks, impressions, avg_position_centi
      from seo_gsc_daily where site_url = ${SITE}
    `) as unknown as {
      page: string
      query: string
      clicks: number
      impressions: number
      avg_position_centi: number
    }[]
    return read.map((row) => ({
      page: row.page,
      query: row.query,
      clicks: row.clicks,
      impressions: row.impressions,
      avgPositionCenti: row.avg_position_centi,
    }))
  }

  /** G-SEO-03's analysis over the warehouse rows, turned into title-rewrite proposals. */
  function proposalsFrom(rows: readonly SeoQueryRow[]): readonly SuggestionCandidateProposal[] {
    return ctrOutliers(rows, {
      ...CTR_OUTLIER_POSITION_WINDOW,
      minImpressions: 100,
      minShortfallBp: 100,
      minPeerGroups: 2,
    }).map((finding) => ({
      findingKind: 'ctr_outlier' as const,
      targetKind: 'page_title',
      targetRef: `${finding.page}#title`,
      query: finding.query,
    }))
  }

  it('the profile in force really does ban the term the fixture carries', () => {
    // The guard that stops the whole describe going vacuous: a profile with an empty term list would make
    // every assertion below true by there being nothing to catch.
    expect(bannedTerm.length).toBeGreaterThan(2)
    expect(policy.bannedClaimTerms.length).toBeGreaterThan(5)
    expect(policy.medicalClaimsPermitted).toBe(false)
  })

  it('persists the clean findings and no row whose query carries the term', async () => {
    const rows = await seedWarehouse()
    const proposals = proposalsFrom(rows)
    // The fixture has to actually produce a banned proposal, or the filter is never exercised.
    expect(proposals.some((proposal) => (proposal.query ?? '').includes(bannedTerm))).toBe(true)

    const log = capturingLogger()
    const summary = await ingestSuggestionCandidates(
      {
        principal: seoAgent(),
        policy,
        persist: (candidates) => insertSuggestionCandidates(sql, candidates),
        logger: log.logger,
      },
      { siteUrl: SITE, runId: null, proposals },
    )

    // Counted in SQL over every row for this property. Zero is the criterion.
    expect(await countCandidatesMentioning(sql, { siteUrl: SITE, phrase: bannedTerm })).toBe(0)
    // And the control that stops that zero being the zero of an empty table.
    expect(summary.inserted).toBeGreaterThan(0)
    expect((await readSuggestionCandidates(sql, SITE)).length).toBe(summary.inserted)
    expect(summary.droppedByRule.banned_claim_term).toBeGreaterThan(0)
  })

  it('logs the drop with the term redacted, and the log carries neither the term nor the query', async () => {
    const rows = await seedWarehouse()
    const log = capturingLogger()
    await ingestSuggestionCandidates(
      {
        principal: seoAgent(),
        policy,
        persist: (candidates) => insertSuggestionCandidates(sql, candidates),
        logger: log.logger,
      },
      { siteUrl: SITE, runId: null, proposals: proposalsFrom(rows) },
    )
    expect(log.lines.length).toBeGreaterThan(0)
    const everything = JSON.stringify(log.lines)
    // A log is a persisted artefact. A filter whose log carried the phrase verbatim would have moved the
    // problem to the place that gets grepped and pasted into tickets.
    expect(everything).not.toContain(bannedTerm)
    expect(everything).not.toContain(`${bannedTerm} massage abu dhabi`)
    // What it does carry: the rule, and the term's first character and length.
    expect(everything).toContain('banned_claim_term')
    expect(log.lines[0]?.fields['redacted']).toBe(
      `${bannedTerm.slice(0, 1)}${'•'.repeat(bannedTerm.length - 1)}`,
    )
  })

  it('the policy layer refuses a principal without seo_suggestion:propose, and nothing is written', async () => {
    const rows = await seedWarehouse()
    const log = capturingLogger()
    await expect(
      ingestSuggestionCandidates(
        {
          principal: staffPrincipal('marketer'),
          policy,
          persist: (candidates) => insertSuggestionCandidates(sql, candidates),
          logger: log.logger,
        },
        { siteUrl: SITE, runId: null, proposals: proposalsFrom(rows) },
      ),
    ).rejects.toThrow(PrincipalDenied)
    // The refusal arrives before the work: no row, and not even a drop logged.
    expect(await readSuggestionCandidates(sql, SITE)).toHaveLength(0)
    expect(log.lines).toHaveLength(0)
  })
})
