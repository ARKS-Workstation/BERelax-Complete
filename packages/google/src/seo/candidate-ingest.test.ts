import {
  agentPrincipal,
  type CompliancePolicy,
  PrincipalDenied,
  SEO_AGENT_PRINCIPAL,
  type SuggestionCandidateProposal,
  staffPrincipal,
} from '@berelax/core'
import type { SuggestionCandidateInsert } from '@berelax/db'
import { describe, expect, it } from 'vitest'
import {
  ingestSuggestionCandidates,
  type SeoIngestLogLine,
  type SuggestionCandidatePersist,
} from './candidate-ingest.ts'

/**
 * The ingest boundary, driven with no database.
 *
 * The half this file proves is the one that has to hold before a row exists: what is screened out never
 * reaches the writer, and the log line that records the drop carries neither the banned term nor the query.
 * The other half — that no row in `seo_suggestion_candidate` carries the term, counted in SQL over the whole
 * table — is `packages/google/src/seo/seo-agent-cage.itest.ts`.
 */

const STRICTER: CompliancePolicy = {
  bannedClaimTerms: ['therapeutic', 'treatment', 'pain relief', 'cure', 'heal', 'medical'],
  permittedPublicTitles: ['Therapist', 'Senior Therapist'],
  medicalClaimsPermitted: false,
}

const SITE = 'sc-domain:berelax.example'

const seoAgent = () => {
  const principal = agentPrincipal(SEO_AGENT_PRINCIPAL)
  if (principal === null) throw new Error('the seo_agent principal is not declared')
  return principal
}

/** A writer that records what it was handed and writes nothing. */
const recordingWriter = () => {
  const handed: SuggestionCandidateInsert[] = []
  const persist: SuggestionCandidatePersist = async (candidates) => {
    handed.push(...candidates)
    return { inserted: candidates.length, skipped: 0 }
  }
  return { handed, persist }
}

const capturingLogger = () => {
  const lines: SeoIngestLogLine[] = []
  return { lines, logger: { log: (line: SeoIngestLogLine) => lines.push(line) } }
}

const proposal = (
  over: Partial<SuggestionCandidateProposal> = {},
): SuggestionCandidateProposal => ({
  findingKind: 'ctr_outlier',
  targetKind: 'page_title',
  targetRef: '/treatments/hot-oil-massage#title',
  query: 'hot oil massage abu dhabi',
  ...over,
})

describe('the ingest boundary drops before it writes', () => {
  it('never hands a banned-term candidate to the writer, and keeps the rest', async () => {
    const writer = recordingWriter()
    const log = capturingLogger()
    const summary = await ingestSuggestionCandidates(
      { principal: seoAgent(), policy: STRICTER, persist: writer.persist, logger: log.logger },
      {
        siteUrl: SITE,
        runId: null,
        proposals: [
          proposal({ query: 'massage abu dhabi' }),
          proposal({ query: 'therapeutic massage abu dhabi', targetRef: '/spa#title' }),
          proposal({ query: 'can massage cure back pain', targetRef: '/faq#parking' }),
        ],
      },
    )
    expect(summary.proposed).toBe(3)
    expect(summary.kept).toBe(1)
    expect(summary.dropped).toBe(2)
    expect(summary.inserted).toBe(1)
    expect(summary.droppedByRule.banned_claim_term).toBe(2)
    // The writer saw exactly the one survivor. This is the criterion at the boundary rather than at the table.
    expect(writer.handed).toHaveLength(1)
    expect(writer.handed[0]?.query).toBe('massage abu dhabi')
  })

  it('the drop log carries the term REDACTED and carries no query at all', async () => {
    const writer = recordingWriter()
    const log = capturingLogger()
    await ingestSuggestionCandidates(
      { principal: seoAgent(), policy: STRICTER, persist: writer.persist, logger: log.logger },
      {
        siteUrl: SITE,
        runId: '01a0c000-0000-7000-8000-000000000000',
        proposals: [proposal({ query: 'therapeutic massage for sciatica' })],
      },
    )
    expect(log.lines).toHaveLength(1)
    const line = log.lines[0]
    expect(line?.rule).toBe('banned_claim_term')
    expect(line?.fields['redacted']).toBe('t••••••••••')
    // Every field of every line, greppable as a whole, must carry neither the term nor the query. The message
    // is included, because the message is where a term ends up when somebody interpolates it "just for
    // debugging".
    const everything = JSON.stringify(log.lines)
    expect(everything).not.toContain('therapeutic')
    expect(everything).not.toContain('sciatica')
    // And it does carry what an operator needs: the rule, the site, the run and the locator.
    expect(everything).toContain('banned_claim_term')
    expect(everything).toContain(SITE)
    expect(everything).toContain('01a0c000-0000-7000-8000-000000000000')
    expect(everything).toContain('/treatments/hot-oil-massage#title')
  })

  it('the control: with nothing to drop, the writer gets every proposal and the log is empty', async () => {
    // Without this, the two cases above are satisfied by a boundary that drops everything — which would
    // report a perfectly clean table and an agent that has never proposed anything.
    const writer = recordingWriter()
    const log = capturingLogger()
    const summary = await ingestSuggestionCandidates(
      { principal: seoAgent(), policy: STRICTER, persist: writer.persist, logger: log.logger },
      {
        siteUrl: SITE,
        runId: null,
        proposals: [
          proposal({ query: 'hot oil massage abu dhabi' }),
          proposal({ query: 'four hands massage price', targetRef: '/pricing#title' }),
        ],
      },
    )
    expect(summary.dropped).toBe(0)
    expect(writer.handed).toHaveLength(2)
    expect(log.lines).toHaveLength(0)
  })

  it('reports a denied target under its own rule, and does not write it', async () => {
    const writer = recordingWriter()
    const log = capturingLogger()
    const summary = await ingestSuggestionCandidates(
      { principal: seoAgent(), policy: STRICTER, persist: writer.persist, logger: log.logger },
      {
        siteUrl: SITE,
        runId: null,
        proposals: [
          proposal({ targetKind: 'robots_txt', targetRef: '/robots.txt', query: 'massage' }),
          proposal({ targetKind: 'body_copy', targetRef: 'link[rel=canonical]', query: 'massage' }),
        ],
      },
    )
    expect(summary.droppedByRule.target_not_allowlisted).toBe(2)
    expect(writer.handed).toHaveLength(0)
    expect(log.lines.map((line) => line.fields['targetRule'])).toEqual([
      'target_kind_not_allowlisted',
      'target_ref_is_a_machine_directive',
    ])
  })

  it('tells "nothing new" from "nothing" by reporting what the writer skipped', async () => {
    // A re-run inserts nothing because of the identity constraint. A summary that reported only `inserted: 0`
    // would look identical to a pass that found nothing at all.
    const log = capturingLogger()
    const summary = await ingestSuggestionCandidates(
      {
        principal: seoAgent(),
        policy: STRICTER,
        persist: async (candidates) => ({ inserted: 0, skipped: candidates.length }),
        logger: log.logger,
      },
      {
        siteUrl: SITE,
        runId: null,
        proposals: [proposal(), proposal({ targetRef: '/spa#title' })],
      },
    )
    expect(summary.kept).toBe(2)
    expect(summary.inserted).toBe(0)
    expect(summary.skipped).toBe(2)
  })
})

describe('the ingest boundary is gated by the policy layer, not by the caller', () => {
  it('refuses a principal that does not hold seo_suggestion:propose, before anything is screened', async () => {
    const writer = recordingWriter()
    const log = capturingLogger()
    // The marketer drafts content and cannot propose: a human approves or rejects, they do not propose to
    // themselves. The refusal has to arrive before the budget is spent, so nothing reaches the writer.
    await expect(
      ingestSuggestionCandidates(
        {
          principal: staffPrincipal('marketer'),
          policy: STRICTER,
          persist: writer.persist,
          logger: log.logger,
        },
        { siteUrl: SITE, runId: null, proposals: [proposal()] },
      ),
    ).rejects.toThrow(PrincipalDenied)
    expect(writer.handed).toHaveLength(0)
    expect(log.lines).toHaveLength(0)
  })

  it('the control: the seo_agent principal is permitted, so the refusal is about the capability', async () => {
    const writer = recordingWriter()
    const log = capturingLogger()
    await expect(
      ingestSuggestionCandidates(
        { principal: seoAgent(), policy: STRICTER, persist: writer.persist, logger: log.logger },
        { siteUrl: SITE, runId: null, proposals: [proposal()] },
      ),
    ).resolves.toMatchObject({ kept: 1 })
  })
})
