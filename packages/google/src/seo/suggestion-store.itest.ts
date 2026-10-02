import { randomUUID } from 'node:crypto'
import {
  type CompliancePolicy,
  encloseUntrustedSeoData,
  publicationCanonicalContent,
  SEO_SUGGESTION_LINT_VERSION,
  staffPrincipal,
} from '@berelax/core'
import {
  approveSeoSuggestion,
  createConnection,
  insertSeoSuggestion,
  publicationContentHash,
  publicationRecordById,
  publishSurface,
  readCompliancePolicy,
  recordApproval,
  recordDraft,
  recordLintPass,
  SEO_SUGGESTION_SQLSTATE,
  type Sql,
  type SuggestionRegion,
  seoSuggestionById,
} from '@berelax/db'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  applySeoSuggestion,
  rollbackSeoSuggestion,
  suggestionApplyRefusalOf,
} from '../suggestions/apply.ts'
import {
  runSeoSuggestionDraftPass,
  SEO_ESCALATION_AUDIT_ACTION,
  type SeoDraftRequest,
  type SeoModelAnswer,
} from './draft-suggestions.ts'
import { SEO_RED_TEAM_CORPUS } from './redteam.corpus/index.ts'

/**
 * G-SEO-05 against the real database: the constraint, the exact rollback, the publication chain, the cap.
 *
 * Every acceptance line of this unit except the pure ones is a claim about what PostgreSQL refuses or what
 * `agent_heartbeat` does NOT record, and not one of them can be checked by reading TypeScript. So each is
 * driven as a statement — an insert or an update issued directly, with the ids and the hashes the
 * constraint is about — and the service functions are exercised beside them so the two layers can be seen
 * to agree rather than assumed to.
 *
 * ## Isolation
 *
 * Every surface carries a per-run suffix, so no assertion is a total over a shared table and nothing here
 * depends on file order (brief §12). It cannot clean up after itself and does not try: `seo_suggestion`
 * refuses DELETE for every role (`ZY402`) and so do all three publication tables, which is the property
 * under test. Every count below is a DELTA, taken in SQL rather than through a capped reader — the
 * `settings-store.itest.ts` defect the brief records, where both sides of a subtraction pinned at the
 * reader's limit and three recorded changes read as zero.
 */

const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')
}

let sql: Sql
let policy: CompliancePolicy

/** A surface nothing else in the suite will touch. */
const RUN = randomUUID().slice(0, 8)
const surfaceFor = (name: string): string => `pages/g-seo-05-${name}-${RUN}`

/** A frozen instant, so nothing here depends on how long a test took. */
const AT = new Date('2026-03-01T10:00:00.000Z')
const AT_ISO = AT.toISOString()

/** The critical-path budget docs/08 §8 states, as a figure the DB rows carry. Never the authority. */
const BUDGET = 250 * 1024
const MEASURED = 120 * 1024

const BEFORE: readonly SuggestionRegion[] = Object.freeze([
  { region: 'title', text: 'Deep Tissue' },
  { region: 'meta_description', text: 'Deep tissue in Abu Dhabi.' },
])
const AFTER: readonly SuggestionRegion[] = Object.freeze([
  { region: 'title', text: 'Deep tissue massage in Al Zahiyah — 60 or 90 minutes' },
  {
    region: 'meta_description',
    text: 'A 60 or 90 minute deep tissue massage in Al Zahiyah, open late. Book online.',
  },
])

const sha = async (regions: readonly SuggestionRegion[]): Promise<string> =>
  await publicationContentHash(sql, publicationCanonicalContent([...regions]))

/** The SQLSTATE a statement bounced off, or undefined if it did not bounce. */
async function sqlstateOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    const code = (error as { code?: unknown }).code
    return typeof code === 'string' ? code : `no-sqlstate: ${String(error)}`
  }
}

/** The constraint a statement bounced off, or undefined. What a NOT NULL violation is asserted BY. */
async function constraintOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run()
    return undefined
  } catch (error) {
    const violated = error as {
      column_name?: unknown
      constraint_name?: unknown
      constraint?: unknown
    }
    const name = violated.constraint_name ?? violated.constraint ?? violated.column_name
    return typeof name === 'string' ? name : `no-constraint: ${String(error)}`
  }
}

/** A run row this suite can hang a suggestion off, without going through an agent pass. */
async function freshRunId(): Promise<string> {
  // `finished_at` is not optional on a finished run: `agent_run_check` holds
  // `(outcome = 'running') = (finished_at is null)`, so a `succeeded` row with no finish is refused. The
  // constraint is right and the first version of this helper was wrong, which is the kind of thing a
  // fixture gets wrong silently when it writes a table it does not own.
  const [row] = await sql<{ runId: string }[]>`
    insert into agent_run (agent_key, started_at, finished_at, outcome, cost_fils)
    values ('seo_agent', ${AT}, ${AT}, 'succeeded', 0)
    returning run_id as "runId"
  `
  if (row === undefined) throw new Error('agent_run insert returned no row')
  return row.runId
}

/** Publishes `regions` as the live content of `surface`, so a suggestion has a before-state to replace. */
async function publishLive(surface: string, regions: readonly SuggestionRegion[]): Promise<string> {
  const contentSha256 = await sha(regions)
  await recordDraft(sql, {
    surface,
    contentSha256,
    recordedAt: AT,
    actorKind: 'staff',
    actorLabel: 'Operator Record 1',
  })
  const lint = await recordLintPass(sql, {
    surface,
    contentSha256,
    termsChecked: 12,
    lintedAt: AT,
    actorKind: 'staff',
    actorLabel: 'Operator Record 1',
  })
  const approval = await recordApproval(sql, {
    surface,
    lintPassId: lint.lintPassId,
    contentSha256,
    approverUserId: 'operator-1',
    approverDisplayName: 'Operator Record 1',
    approverRole: 'owner',
    approvedAt: AT,
  })
  const published = await publishSurface(sql, {
    surface,
    lintPassId: lint.lintPassId,
    approvalId: approval.approvalId,
    contentSha256,
    measuredCriticalPathBytes: MEASURED,
    criticalPathBudgetBytes: BUDGET,
    recordedAt: AT,
    actorKind: 'staff',
    actorLabel: 'Operator Record 1',
  })
  return published.recordId
}

async function storeSuggestion(
  surface: string,
  overrides: {
    readonly after?: readonly SuggestionRegion[]
    readonly refusedRules?: readonly string[]
  } = {},
) {
  const after = overrides.after ?? AFTER
  return await insertSeoSuggestion(sql, {
    runId: await freshRunId(),
    surface,
    state: overrides.refusedRules === undefined ? 'proposed' : 'refused',
    beforeRegions: BEFORE,
    beforeContentSha256: await sha(BEFORE),
    afterRegions: after,
    afterContentSha256: await sha(after),
    lintVersion: SEO_SUGGESTION_LINT_VERSION,
    lintTermsChecked: 12,
    refusedRules: overrides.refusedRules ?? [],
    llmProvider: 'deepseek',
    inputTokens: 900,
    outputTokens: 60,
    costFils: 3,
    proposedAt: AT,
  })
}

beforeAll(async () => {
  sql = createConnection({ url, max: 4 })
  const row = await readCompliancePolicy(sql)
  policy = {
    bannedClaimTerms: row.bannedClaimTerms,
    permittedPublicTitles: row.permittedPublicTitles,
    medicalClaimsPermitted: row.medicalClaimsPermitted,
  }
})

afterAll(async () => {
  await sql?.end({ timeout: 5 })
})

describe('the row carries before, after, a rollback descriptor and the run id', () => {
  it('stores all four, and derives the descriptor rather than accepting one', async () => {
    const surface = surfaceFor('shape')
    const row = await storeSuggestion(surface)
    expect(row.runId).toMatch(/^[0-9a-f-]{36}$/)
    expect(row.beforeRegions).toEqual([...BEFORE])
    expect(row.afterRegions).toEqual([...AFTER])
    expect(row.rollbackDescriptor).toEqual({ method: 'publication_revert', surface })
    expect(row.beforeContentSha256).not.toBe(row.afterContentSha256)
  })

  it('REJECTS an insert omitting the rollback descriptor, by the constraint', async () => {
    /*
     * The acceptance line asks for a FAILED INSERT and not for a service-layer guard, and that is why it
     * is written as a statement: `insertSeoSuggestion` derives the descriptor, so there is no way to omit
     * one through the repository at all. This is what holds when somebody writes the INSERT by hand.
     */
    const surface = surfaceFor('no-descriptor')
    const runId = await freshRunId()
    const before = await sha(BEFORE)
    const after = await sha(AFTER)
    const constraint = await constraintOf(
      async () =>
        await sql`
          insert into seo_suggestion (
            run_id, surface, state, before_regions, before_content_sha256, after_regions,
            after_content_sha256, lint_version, lint_terms_checked, llm_provider, input_tokens,
            output_tokens, cost_fils, proposed_at
          ) values (
            ${runId}::uuid, ${surface}, 'proposed', ${sql.json([...BEFORE] as never)}, ${before},
            ${sql.json([...AFTER] as never)}, ${after}, ${SEO_SUGGESTION_LINT_VERSION}, 12,
            'deepseek', 1, 1, 1, ${AT}
          )
        `,
    )
    /*
     * ZY401, and not 23502. The trigger is BEFORE INSERT, so it sees the null first and raises a message
     * that says what a rollback descriptor is for — which is the better failure. The NOT NULL is still
     * there and is still the layer that holds if the trigger is ever dropped, so it is asserted from the
     * catalogue rather than inferred from this statement: a column that silently became nullable would
     * leave this case passing on the trigger alone.
     */
    expect(constraint).toContain('ZY401')
    const [column] = await sql<{ nullable: string }[]>`
      select is_nullable as nullable from information_schema.columns
       where table_name = 'seo_suggestion' and column_name = 'rollback_descriptor'
    `
    expect(column?.nullable).toBe('NO')
  })

  it('REFUSES a descriptor that is present and says nothing — ZY401', async () => {
    const surface = surfaceFor('empty-descriptor')
    const runId = await freshRunId()
    const before = await sha(BEFORE)
    const after = await sha(AFTER)
    const state = await sqlstateOf(
      async () =>
        await sql`
          insert into seo_suggestion (
            run_id, surface, state, before_regions, before_content_sha256, after_regions,
            after_content_sha256, rollback_descriptor, lint_version, lint_terms_checked, llm_provider,
            input_tokens, output_tokens, cost_fils, proposed_at
          ) values (
            ${runId}::uuid, ${surface}, 'proposed', ${sql.json([...BEFORE] as never)}, ${before},
            ${sql.json([...AFTER] as never)}, ${after}, '{}'::jsonb, ${SEO_SUGGESTION_LINT_VERSION}, 12,
            'deepseek', 1, 1, 1, ${AT}
          )
        `,
    )
    // NOT NULL admits `'{}'`, and a rollback nobody can perform is discovered at the worst moment.
    expect(state).toBe(SEO_SUGGESTION_SQLSTATE.rollbackUnusable)
  })

  it('REFUSES a descriptor aimed at another surface — ZY401', async () => {
    const surface = surfaceFor('wrong-surface')
    const runId = await freshRunId()
    const before = await sha(BEFORE)
    const after = await sha(AFTER)
    const state = await sqlstateOf(
      async () =>
        await sql`
          insert into seo_suggestion (
            run_id, surface, state, before_regions, before_content_sha256, after_regions,
            after_content_sha256, rollback_descriptor, lint_version, lint_terms_checked, llm_provider,
            input_tokens, output_tokens, cost_fils, proposed_at
          ) values (
            ${runId}::uuid, ${surface}, 'proposed', ${sql.json([...BEFORE] as never)}, ${before},
            ${sql.json([...AFTER] as never)}, ${after},
            ${sql.json({ method: 'publication_revert', surface: 'pages/somewhere-else' })},
            ${SEO_SUGGESTION_LINT_VERSION}, 12, 'deepseek', 1, 1, 1, ${AT}
          )
        `,
    )
    expect(state).toBe(SEO_SUGGESTION_SQLSTATE.rollbackUnusable)
  })

  it('REFUSES a suggestion that changes nothing, by CHECK', async () => {
    const surface = surfaceFor('no-op')
    const constraint = await constraintOf(
      async () => await storeSuggestion(surface, { after: BEFORE }),
    )
    expect(constraint).toBe('seo_suggestion_changes_something')
  })

  it('REFUSES a DELETE and an evidence UPDATE — ZY402', async () => {
    const row = await storeSuggestion(surfaceFor('immutable'))
    expect(
      await sqlstateOf(
        async () => await sql`delete from seo_suggestion where id = ${row.id}::uuid`,
      ),
    ).toBe(SEO_SUGGESTION_SQLSTATE.evidenceImmutable)
    expect(
      await sqlstateOf(
        async () =>
          await sql`
            update seo_suggestion set after_content_sha256 = ${await sha(BEFORE)}
             where id = ${row.id}::uuid
          `,
      ),
    ).toBe(SEO_SUGGESTION_SQLSTATE.evidenceImmutable)
    // And the control: the STATE does move, or the table would be unusable rather than append-only.
    const approved = await approveSeoSuggestion(sql, row.id)
    expect(approved.state).toBe('approved')
  })

  it('REFUSES promoting a refused suggestion past its own refusal — ZY402', async () => {
    const row = await storeSuggestion(surfaceFor('refused'), {
      refusedRules: ['banned_claim_term'],
    })
    expect(row.state).toBe('refused')
    expect(
      await sqlstateOf(
        async () =>
          await sql`update seo_suggestion set state = 'approved' where id = ${row.id}::uuid`,
      ),
    ).toBe(SEO_SUGGESTION_SQLSTATE.evidenceImmutable)
  })
})

describe('applying flows through the publication control plane', () => {
  it('produces a publication_record carrying the hash, the named approver and the timestamp', async () => {
    const surface = surfaceFor('apply')
    await publishLive(surface, BEFORE)
    const row = await storeSuggestion(surface)
    await approveSeoSuggestion(sql, row.id)

    const applied = await applySeoSuggestion(sql, {
      principal: staffPrincipal('owner'),
      suggestionId: row.id,
      approver: { userId: 'operator-1', displayName: 'Operator Record 1', role: 'owner' },
      measuredCriticalPathBytes: MEASURED,
      criticalPathBudgetBytes: BUDGET,
      now: AT,
    })

    const record = await publicationRecordById(sql, applied.recordId)
    expect(record?.state).toBe('published')
    expect(record?.contentSha256).toBe(row.afterContentSha256)
    /*
     * `supersedes_id` is NULL and that is 0093's rule: `ZZ003` permits the column only on a `published`
     * row whose previous record is also `published` — a correction or a revert — and the apply chain
     * writes draft, lint_passed and approved first. The record the apply REPLACED is reported on the
     * result instead, and the rollback finds it by walking the history.
     */
    expect(record?.supersedesId).toBeNull()
    expect(applied.replacedRecordId).toBeTruthy()
    const [approval] = await sql<{ name: string; at: Date }[]>`
      select approver_display_name as name, approved_at as at
        from publication_approval where id = ${record?.approvalId ?? null}::uuid
    `
    expect(approval?.name).toBe('Operator Record 1')
    expect(approval?.at.toISOString()).toBe(AT_ISO)
    // The linter version is on the SUGGESTION, one hop from the record through `applied_record_id`, and
    // not copied onto the publication row: a second statement of which rules judged the copy would be a
    // second answer the day one of them was edited.
    expect(applied.suggestion.lintVersion).toBe(SEO_SUGGESTION_LINT_VERSION)
    expect(applied.suggestion.appliedRecordId).toBe(applied.recordId)
  })

  it('refuses to apply a suggestion whose stored before-state is not what is live', async () => {
    const surface = surfaceFor('stale')
    await publishLive(surface, AFTER)
    const row = await storeSuggestion(surface)
    await approveSeoSuggestion(sql, row.id)
    const error = await applySeoSuggestion(sql, {
      principal: staffPrincipal('owner'),
      suggestionId: row.id,
      approver: { userId: 'operator-1', displayName: 'Operator Record 1', role: 'owner' },
      measuredCriticalPathBytes: MEASURED,
      criticalPathBudgetBytes: BUDGET,
      now: AT,
    }).catch((caught: unknown) => caught)
    expect(suggestionApplyRefusalOf(error)).toBe('suggestion_before_state_is_not_live')
  })

  it('cannot apply a suggestion the banned-claims lint refused, at all', async () => {
    const surface = surfaceFor('lint-refused')
    await publishLive(surface, BEFORE)
    // The real profile's own terms, read from the database rather than restated. `banned_claim_terms` is
    // what G-REV-04's English reply tripped on, and the stand-in in `suggestion.test.ts` is held to this
    // row by this assertion rather than by a comment.
    const banned = policy.bannedClaimTerms[0]
    expect(banned, 'regulatory_profile_current holds no banned claim term').toBeDefined()
    const refusedCopy: readonly SuggestionRegion[] = [
      { region: 'title', text: `${banned as string} deep tissue massage in Al Zahiyah` },
      { region: 'meta_description', text: 'Book a 60 or 90 minute massage in Al Zahiyah.' },
    ]
    const row = await storeSuggestion(surface, {
      after: refusedCopy,
      refusedRules: ['banned_claim_term'],
    })
    // One: it is `refused`, and ZY402 refuses the move to `approved`, so it can never become appliable.
    expect(
      await sqlstateOf(
        async () =>
          await sql`update seo_suggestion set state = 'approved' where id = ${row.id}::uuid`,
      ),
    ).toBe(SEO_SUGGESTION_SQLSTATE.evidenceImmutable)
    // Two: even if it somehow were approved, the apply re-lints against the profile in force. Proven on a
    // separate row inserted as `proposed` with the same copy, so the two layers are seen to agree.
    const sneaked = await insertSeoSuggestion(sql, {
      runId: await freshRunId(),
      surface,
      state: 'proposed',
      beforeRegions: BEFORE,
      beforeContentSha256: await sha(BEFORE),
      afterRegions: refusedCopy,
      afterContentSha256: await sha(refusedCopy),
      lintVersion: SEO_SUGGESTION_LINT_VERSION,
      lintTermsChecked: 12,
      refusedRules: [],
      llmProvider: 'deepseek',
      inputTokens: 1,
      outputTokens: 1,
      costFils: 1,
      proposedAt: AT,
    })
    await approveSeoSuggestion(sql, sneaked.id)
    const error = await applySeoSuggestion(sql, {
      principal: staffPrincipal('owner'),
      suggestionId: sneaked.id,
      approver: { userId: 'operator-1', displayName: 'Operator Record 1', role: 'owner' },
      measuredCriticalPathBytes: MEASURED,
      criticalPathBudgetBytes: BUDGET,
      now: AT,
    }).catch((caught: unknown) => caught)
    expect(suggestionApplyRefusalOf(error)).toBe('suggestion_fails_the_lint')
  })
})

describe('rollback is exact', () => {
  it('restores the prior content hash byte-for-byte across the round trip', async () => {
    const surface = surfaceFor('rollback')
    await publishLive(surface, BEFORE)
    const row = await storeSuggestion(surface)
    await approveSeoSuggestion(sql, row.id)

    const beforeHash = row.beforeContentSha256
    const applied = await applySeoSuggestion(sql, {
      principal: staffPrincipal('owner'),
      suggestionId: row.id,
      approver: { userId: 'operator-1', displayName: 'Operator Record 1', role: 'owner' },
      measuredCriticalPathBytes: MEASURED,
      criticalPathBudgetBytes: BUDGET,
      now: AT,
    })
    const liveAfterApply = await publicationRecordById(sql, applied.recordId)
    expect(liveAfterApply?.contentSha256).toBe(row.afterContentSha256)

    const rolledBack = await rollbackSeoSuggestion(sql, {
      principal: staffPrincipal('owner'),
      suggestionId: row.id,
      actorLabel: 'Operator Record 1',
      measuredCriticalPathBytes: MEASURED,
      criticalPathBudgetBytes: BUDGET,
      now: AT,
    })
    /*
     * The acceptance line's own assertion: the stored content hash before and after the round trip. It is
     * a hash and not a string comparison because the hash is what the chain is keyed on — `ZY403` has
     * already refused the state move unless the record carries exactly this value, so this assertion is
     * the readable form of a refusal the database made.
     */
    expect(rolledBack.contentSha256).toBe(beforeHash)
    expect(rolledBack.suggestion.state).toBe('rolled_back')
    const [liveNow] = await sql<{ contentSha256: string }[]>`
      select content_sha256 as "contentSha256" from publication_record
       where surface = ${surface} order by seq desc limit 1
    `
    expect(liveNow?.contentSha256).toBe(beforeHash)
  })

  it('restores the version that WAS live, not the oldest one in the ledger', async () => {
    /*
     * Two earlier published versions, so "the newest published record before the applied one" and "the
     * oldest one" are different records. Without this the rollback suite above could not tell the two
     * apart — the surface had exactly one earlier version, so any walk gave the right answer — and gate
     * case 164k would be proving nothing. It is also what makes the hash POST-condition in
     * `rollbackSeoSuggestion` reachable: picking the wrong record is a named refusal rather than a
     * silently restored document.
     */
    const surface = surfaceFor('two-versions')
    const V1: readonly SuggestionRegion[] = [
      { region: 'title', text: 'Deep Tissue, first wording' },
      { region: 'meta_description', text: 'The first meta description.' },
    ]
    await publishLive(surface, V1)
    await publishLive(surface, BEFORE)
    const row = await storeSuggestion(surface)
    await approveSeoSuggestion(sql, row.id)
    await applySeoSuggestion(sql, {
      principal: staffPrincipal('owner'),
      suggestionId: row.id,
      approver: { userId: 'operator-1', displayName: 'Operator Record 1', role: 'owner' },
      measuredCriticalPathBytes: MEASURED,
      criticalPathBudgetBytes: BUDGET,
      now: AT,
    })
    const rolledBack = await rollbackSeoSuggestion(sql, {
      principal: staffPrincipal('owner'),
      suggestionId: row.id,
      actorLabel: 'Operator Record 1',
      measuredCriticalPathBytes: MEASURED,
      criticalPathBudgetBytes: BUDGET,
      now: AT,
    })
    expect(rolledBack.contentSha256).toBe(await sha(BEFORE))
    expect(rolledBack.contentSha256).not.toBe(await sha(V1))
  }, 30_000)

  it('REFUSES a state move naming a publication that carries the wrong hash — ZY403', async () => {
    const surface = surfaceFor('wrong-hash')
    const liveRecordId = await publishLive(surface, BEFORE)
    const row = await storeSuggestion(surface)
    await approveSeoSuggestion(sql, row.id)
    // The record carrying the BEFORE hash, presented as the record the suggestion was applied as. This is
    // the mistake that makes a suggestion read as live without having changed anything.
    expect(
      await sqlstateOf(
        async () =>
          await sql`
            update seo_suggestion
               set state = 'applied', applied_record_id = ${liveRecordId}::uuid
             where id = ${row.id}::uuid
          `,
      ),
    ).toBe(SEO_SUGGESTION_SQLSTATE.publishedHashDisagrees)
  })
})

describe('the drafting pass: the corpus, the audit delta and the cap', () => {
  /** A drafter that answers with the payload's objective, as a fully-succumbed model would. */
  function succumbingDrafter(objective: string, costFils: number) {
    return async (request: SeoDraftRequest): Promise<SeoModelAnswer> => ({
      provider: 'deepseek',
      kind: 'completion',
      text: objective,
      inputTokens: 900,
      outputTokens: 60,
      costFils,
      regions: [
        { region: 'title', text: `Deep tissue massage in Al Zahiyah ${request.surface.slice(-6)}` },
        {
          region: 'meta_description',
          text: 'A 60 or 90 minute massage in Al Zahiyah. Book online.',
        },
      ],
    })
  }

  it('yields at most a suggestion row per payload, zero publications, and one security event each', async () => {
    const audited: { action: string; entityId: string }[] = []
    const requests: SeoDraftRequest[] = SEO_RED_TEAM_CORPUS.map((payload, index) => ({
      target: { kind: 'page_title', ref: `/treatments/p-${index}#title` },
      surface: surfaceFor(`corpus-${index}`),
      beforeRegions: BEFORE,
      evidence: [
        encloseUntrustedSeoData({
          source: payload.carrier,
          text: payload.text,
        }),
      ],
    }))

    const [publicationsBefore] = await sql<{ n: string }[]>`
      select count(*)::text as n from publication_record
    `
    const [auditBefore] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = ${SEO_ESCALATION_AUDIT_ACTION}
    `

    let at = 0
    const result = await runSeoSuggestionDraftPass(
      sql,
      {
        draft: async (request) => {
          const payload = SEO_RED_TEAM_CORPUS[at] as (typeof SEO_RED_TEAM_CORPUS)[number]
          at += 1
          return await succumbingDrafter(payload.objective, 1)(request)
        },
        audit: async (event) => {
          audited.push({ action: event.action, entityId: event.entityId })
          await sql`
            insert into audit_event (actor_kind, actor_label, action, entity_type, entity_id, operation,
                                     after_state)
            values ('agent', 'seo_agent', ${event.action}, 'seo_suggestion', ${event.entityId},
                    'denied', ${sql.json(event.detail as never)})
          `
        },
      },
      requests,
      AT_ISO,
      { jobId: `corpus-${RUN}` },
    )

    expect(result.outcome).toBe('succeeded')
    // Every payload produced a row and NOT a proposal: the screen refused all 25.
    expect(result.proposed).toEqual([])
    expect(result.refused).toHaveLength(SEO_RED_TEAM_CORPUS.length)
    expect(result.escalationsRecorded).toBe(SEO_RED_TEAM_CORPUS.length)
    expect(audited).toHaveLength(SEO_RED_TEAM_CORPUS.length)
    expect(new Set(audited.map((event) => event.action))).toEqual(
      new Set([SEO_ESCALATION_AUDIT_ACTION]),
    )

    // Zero publications. Counted in SQL as a DELTA — a total would be a claim about every other suite.
    const [publicationsAfter] = await sql<{ n: string }[]>`
      select count(*)::text as n from publication_record
    `
    expect(Number(publicationsAfter?.n)).toBe(Number(publicationsBefore?.n))
    const [auditAfter] = await sql<{ n: string }[]>`
      select count(*)::text as n from audit_event where action = ${SEO_ESCALATION_AUDIT_ACTION}
    `
    expect(Number(auditAfter?.n) - Number(auditBefore?.n)).toBe(SEO_RED_TEAM_CORPUS.length)

    // And every stored row names the rules that refused it, which is what makes the refusal actionable.
    for (const row of result.refused) {
      const stored = await seoSuggestionById(sql, row.id)
      expect(stored?.state).toBe('refused')
      expect((stored?.refusedRules ?? []).length).toBeGreaterThan(0)
      expect(stored?.lintVersion).toBe(SEO_SUGGESTION_LINT_VERSION)
    }
  }, 60_000)

  it('aborts mid-run over the cap, persists the partial cost, and does not set last_success_at', async () => {
    const [definition] = await sql<{ cap: string }[]>`
      select budget_fils_per_run::text as cap from agent_definition where agent_key = 'seo_agent'
    `
    const cap = Number(definition?.cap)
    expect(cap, 'seo_agent has no per-run budget, so there is no cap to exceed').toBeGreaterThan(0)

    const [before] = await sql<{ lastSuccess: Date | null }[]>`
      select last_success_at as "lastSuccess" from agent_heartbeat where agent_key = 'seo_agent'
    `

    // Two requests, each costing the whole cap. The first is charged and stored; the second's charge is
    // what throws, which is what "enforced mid-run" means — a cap checked at the end has already been
    // exceeded.
    const requests: SeoDraftRequest[] = [0, 1].map((index) => ({
      target: { kind: 'page_title', ref: `/treatments/cap-${index}#title` },
      surface: surfaceFor(`cap-${index}`),
      beforeRegions: BEFORE,
      evidence: [encloseUntrustedSeoData({ source: 'gsc_query', text: 'deep tissue abu dhabi' })],
    }))
    const result = await runSeoSuggestionDraftPass(
      sql,
      {
        draft: succumbingDrafter('Shorten the title; it truncates on mobile.', cap),
        audit: async () => {},
      },
      requests,
      AT_ISO,
      { jobId: `cap-${RUN}` },
    )

    expect(result.outcome).toBe('budget_exceeded')
    // The partial cost is persisted: the first call really happened and really cost what it cost.
    const [run] = await sql<{ cost: string; outcome: string }[]>`
      select cost_fils::text as cost, outcome from agent_run where run_id = ${result.runId}::uuid
    `
    expect(run?.outcome).toBe('budget_exceeded')
    expect(Number(run?.cost)).toBe(cap)
    // And `last_success_at` is untouched, so the watchdog sees the agent go quiet rather than succeed.
    const [after] = await sql<{ lastSuccess: Date | null }[]>`
      select last_success_at as "lastSuccess" from agent_heartbeat where agent_key = 'seo_agent'
    `
    expect(after?.lastSuccess?.toISOString() ?? null).toBe(
      before?.lastSuccess?.toISOString() ?? null,
    )
    // The work done before the cap was reached is on file. That split is correct: the suggestion is real
    // and the run did not succeed.
    expect(result.proposed.length + result.refused.length).toBe(1)
  }, 30_000)
})
