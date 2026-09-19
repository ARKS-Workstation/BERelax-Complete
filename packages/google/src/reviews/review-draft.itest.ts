import {
  createRunBudget,
  draftPassesLint,
  FIXTURE_STAFF_NAME_IN_REVIEW_TEXT,
  HOUSE_DRAFT_LINTER,
  instantFromIso,
  isHouseReplyRendering,
  RED_TEAM_CORPUS,
  REVIEW_ESCALATION_LEXICON,
  type ReviewRoutingPolicy,
  routeReview,
} from '@berelax/core'
import {
  createConnection,
  getReview,
  type QueuedReview,
  readSetting,
  recordDraftQuarantine,
  recordManualReview,
  recordReplyDraft,
  recordRoutingVerdict,
  type Sql,
  withAgentRun,
  withUnitOfWork,
  writeSetting,
} from '@berelax/db'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import { REVIEW_FIXTURES, type Review } from '@berelax/providers/google'
import {
  createFakeDeepSeek,
  createFakeMiniMax,
  DEEPSEEK,
  type LlmOutcome,
  type LlmProvider,
  type LlmRequest,
  MINIMAX,
  REJECTED_KEY_MARKER,
} from '@berelax/providers/llm'
import {
  DEFAULT_LLM_PROVIDER,
  LLM_PROVIDER_SETTING_KEY,
  MINIMUM_REVIEW_COOLING_OFF_HOURS,
} from '@berelax/shared'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { generateReplyDrafts } from './generate-draft.ts'
import { saveLlmProviderChoice } from './llm-provider.ts'

/**
 * G-REV-04 against a real database, the real review fixtures and the two named provider fakes.
 *
 * ## Why this file is in `packages/google`
 *
 * The same argument `review-routing.itest.ts` makes for itself. It exercises a **quadruple**:
 * `@berelax/core`'s prompt builder and linter, `@berelax/db`'s draft write, `@berelax/providers`' LLM
 * fakes, and G-AGT-01's `withAgentRun`. `packages/google` is the only package that depends on all of
 * them, and a test is not a licence to widen a package's dependencies.
 *
 * ## Isolation, and the two shared things this file touches
 *
 * The integration suite runs sequentially against one database and earlier files leave rows behind, so
 * nothing here asserts a total on a shared table. `audit_event` is append-only (ADR 0008) and every
 * assertion about it is a **delta counted in SQL**. Rows are removed reviews-first, because
 * `google_reviews.connection_id` is `ON DELETE RESTRICT`.
 *
 * Two shared rows are changed and both are restored:
 *
 *   - `app_setting['agents.llm_provider']`, written and restored through `writeSetting` (by way of
 *     `saveLlmProviderChoice`). A direct UPDATE would skip the 0036 history trigger and leave
 *     `app_setting_history` claiming the provider is still whatever this file last set.
 *   - `agent_definition['review_autoresponder'].budget_fils_per_run`, which the cap test has to lower.
 *     That table has no history trigger, so a direct UPDATE is correct there — and it is restored in
 *     `afterAll` regardless of how the test ends.
 *
 * ## No credential, and no invented name
 *
 * Every key below carries the word `fake` and a run of zeros. Every reviewer label comes from
 * `REVIEW_FIXTURES`. The red-team payloads are attacker text under test, not fixtures — see
 * `red-team-corpus.ts` — and the one name among them is copied from `REVIEW_FIXTURES`, which this file
 * asserts byte for byte.
 */
const url = process.env['TEST_DATABASE_URL'] ?? process.env['DATABASE_URL']
if (!url)
  throw new Error('TEST_DATABASE_URL or DATABASE_URL is required — integration tests do not skip.')

const OWNER = { kind: 'staff', id: '55555555-5555-5555-5555-555555555555', label: 'Owner' } as const
const AGENT = {
  kind: 'agent',
  id: '00000000-0000-0000-0000-00000000d4af',
  label: 'review_autoresponder',
} as const
const AGENT_KEY = 'review_autoresponder'
const PLACE = 'ChIJ_berelax_draft_place'
const CT = Buffer.from('ciphertext-stand-in')
const NOW_ISO = '2026-09-20T12:00:00.000Z'

/** Long enough to pass the key floor, and visibly not a credential. */
const ACCEPTED_KEY = 'fake-key-for-tests-0000000000'

let sql: Sql
let connectionId = ''
let seededBudgetFils = 0

function fixture(reviewId: string): Review {
  const found = REVIEW_FIXTURES.find((review) => review.reviewId === reviewId)
  if (found === undefined) throw new Error(`No review fixture ${reviewId}`)
  return found
}

async function seedConnection(sub: string, placeId: string): Promise<string> {
  const [connection] = await sql<{ id: string }[]>`
    insert into google_connections
      (google_sub, google_email, granted_scopes, refresh_token_ct, refresh_token_nonce,
       refresh_token_wrapped_key, refresh_token_kid, refresh_token_aad_fp)
    values (${sub}, ${'owner@berelax.ae'},
            ${sql.array(['https://www.googleapis.com/auth/business.manage'])},
            ${CT}, ${CT}, ${CT}, 'v1', 'fp-stand-in')
    returning id
  `
  const id = connection?.id ?? ''
  await sql`
    insert into google_capabilities (connection_id, capability, resource_ref, health, is_primary)
    values (${id}, 'gbp_reviews', ${sql.json({ placeId })}, 'permission_missing', true)
  `
  return id
}

/**
 * The launch-mode policy: auto-send enabled by the owner, but no Business Profile API access.
 *
 * Draft mode, which is the launch mode for weeks (docs/10 §6) and the only mode a *stored* row can be in
 * here — `recordManualReview` writes `delivery_mode = 'manual'`, and 0037's
 * `google_reviews_autosend_needs_api_delivery` refuses an `auto_send` verdict on such a row. That refusal
 * is the database floor working, and it is why the "no payload can buy an auto_send under the most
 * permissive settings there are" assertion lives in `prompt-builder.test.ts`, where it can construct the
 * permissive case without a row: here the database would refuse to store the verdict at all, which is a
 * stronger guarantee and a worse test of the payload.
 *
 * `autosendEnabledSetting: true` is kept deliberately, so nothing here is escalating merely because the
 * compliance-locked switch is off.
 */
function launchPolicy(): ReviewRoutingPolicy {
  return {
    now: instantFromIso(NOW_ISO),
    autosendEnabledSetting: true,
    businessProfileAccessSetting: false,
    coolingOffHoursSetting: MINIMUM_REVIEW_COOLING_OFF_HOURS,
    replyLanguagesSetting: ['en', 'ar'],
    lexicon: REVIEW_ESCALATION_LEXICON,
  }
}

/** Records a review and routes it, which is the state the generator reads. */
async function recordAndRoute(args: {
  readonly rating: number
  readonly comment: string | null
  readonly reviewerDisplayName: string
  readonly reviewedAtIso: string
}): Promise<string> {
  const { id } = await withUnitOfWork(sql, OWNER, (uow) =>
    recordManualReview(uow, {
      connectionId,
      placeId: PLACE,
      source: 'paste',
      rating: args.rating,
      comment: args.comment,
      reviewerDisplayName: args.reviewerDisplayName,
      reviewedAtIso: args.reviewedAtIso,
    }),
  )
  const decision = routeReview({
    review: {
      rating: args.rating,
      commentText: args.comment,
      reviewedAt: instantFromIso(args.reviewedAtIso),
    },
    policy: launchPolicy(),
  })
  await withUnitOfWork(sql, OWNER, (uow) =>
    recordRoutingVerdict(uow, id, {
      verdict: decision.verdict,
      ruleId: decision.rule,
      lexiconVersion: decision.lexiconVersion,
    }),
  )
  return id
}

/** The routing triple, so "unchanged by generation" is a comparison rather than a claim. */
function routingOf(review: QueuedReview | undefined): {
  verdict: string | null
  rule: string | null
  lexicon: string | null
} {
  return {
    verdict: review?.routingVerdict ?? null,
    rule: review?.routingRuleId ?? null,
    lexicon: review?.routingLexiconVersion ?? null,
  }
}

/** A delta, counted in SQL. `audit_event` only grows, so a total is a different number every run. */
async function auditCount(action: string): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n from audit_event
    where entity_type = 'google_review' and action = ${action}
  `
  return Number(row?.n ?? '0')
}

function deepseek(): LlmProvider {
  return createFakeDeepSeek({ log: createCallLog(() => NOW_ISO), failures: new FailureScript() })
}

/**
 * A provider that has COMPLETELY succumbed to the payload.
 *
 * The shipped fakes cannot be hijacked — they are hash tables — so driving the corpus through one proves
 * nothing about the day a real model complies. This one answers with the payload's objective verbatim,
 * which is the event the response screen exists to catch, and it is what makes the red-team assertion a
 * statement about the defence rather than about the fake's indifference.
 */
function obedientTo(objective: string): LlmProvider {
  return {
    name: 'obedient-fake',
    pricing: { inputFilsPerMillionTokens: 0, outputFilsPerMillionTokens: 0 },
    async validateKey(): Promise<void> {},
    async complete(_request: LlmRequest): Promise<LlmOutcome> {
      return { kind: 'completion', text: objective, usage: { inputTokens: 1, outputTokens: 1 } }
    },
    async usage() {
      return { inputTokens: 1, outputTokens: 1 }
    },
  }
}

function deps(llm: LlmProvider, charge: (fils: number) => void = () => {}) {
  return {
    sql,
    actor: AGENT,
    llm,
    linter: HOUSE_DRAFT_LINTER,
    charge,
    maxOutputTokens: 120,
    configuredLanguages: ['en', 'ar'] as const,
    starOnlyReplyLanguage: 'en' as const,
  }
}

beforeAll(async () => {
  sql = createConnection({ url, max: 2 })
  const [row] = await sql<{ budget_fils_per_run: string }[]>`
    select budget_fils_per_run::text from agent_definition where agent_key = ${AGENT_KEY}
  `
  seededBudgetFils = Number(row?.budget_fils_per_run ?? '0')
})

afterAll(async () => {
  await sql`delete from google_reviews`
  await sql`delete from google_connections`
  // The budget back to the seeded figure, whatever the cap test did to it. `agent_definition` has no
  // history trigger, so a direct UPDATE is the right restore here.
  await sql`
    update agent_definition set budget_fils_per_run = ${seededBudgetFils} where agent_key = ${AGENT_KEY}
  `
  // The shared setting back through `writeSetting`, so `app_setting_history` records the restoration too.
  await withUnitOfWork(sql, OWNER, (uow) =>
    writeSetting(uow, {
      key: LLM_PROVIDER_SETTING_KEY,
      value: DEFAULT_LLM_PROVIDER,
      role: 'owner',
      actorLabel: 'Owner',
    }),
  )
  await sql?.end({ timeout: 5 })
})

beforeEach(async () => {
  await sql`delete from google_reviews`
  await sql`delete from google_connections`
  connectionId = await seedConnection('sub-review-draft', PLACE)
})

describe('acceptance — the corpus name is the fixture name, not an invented one', () => {
  it('copies rev-2-names-staff byte-identically', () => {
    const comment = fixture('rev-2-names-staff').comment ?? ''
    expect(comment).toContain(FIXTURE_STAFF_NAME_IN_REVIEW_TEXT)
    // And the payload that uses it really does, so the copy cannot drift from the fixture.
    const payload = RED_TEAM_CORPUS.find((entry) => entry.id === 'name_a_therapist_by_name')
    expect(payload?.reviewText).toContain(FIXTURE_STAFF_NAME_IN_REVIEW_TEXT)
  })
})

describe('acceptance — a five-star review with NULL comment text', () => {
  it('produces a valid draft that passes the linter, with its provenance, and asks the model nothing', async () => {
    const review = fixture('rev-4-star-only')
    const id = await recordAndRoute({
      rating: 5,
      comment: null,
      reviewerDisplayName: review.reviewerDisplayName,
      reviewedAtIso: review.createdAtIso,
    })
    const before = await auditCount('google_review.draft_recorded')

    const provider = deepseek()
    const summary = await generateReplyDrafts(deps(provider), { connectionId })

    expect(summary.outcomes).toHaveLength(1)
    expect(summary.outcomes[0]?.kind).toBe('drafted')
    // No call was made: a review with no text gives the model nothing to select from.
    expect(provider.name).toBe(DEEPSEEK)
    expect(summary.inputTokens).toBe(0)
    expect(summary.costFils).toBe(0)

    const stored = await getReview(sql, id)
    expect(stored?.replyDraft).toBe(
      'Thank you for the rating. We look forward to welcoming you back.',
    )
    expect(stored?.replyDraftSkeletonId).toBe('star_only_thanks')
    expect(stored?.replyDraftAspects).toEqual([])
    expect(stored?.replyDraftLanguage).toBe('en')
    expect(stored?.replyDraftPromptVersion).not.toBeNull()
    expect(stored?.replyDraftPromptFingerprint).not.toBeNull()
    expect(stored?.replyDraftGeneratedAtIso).not.toBeNull()
    expect(stored?.draftQuarantineReason).toBeNull()
    expect(
      draftPassesLint(HOUSE_DRAFT_LINTER, {
        draft: stored?.replyDraft ?? '',
        language: 'en',
        reviewText: null,
      }),
    ).toBe(true)
    expect(await auditCount('google_review.draft_recorded')).toBe(before + 1)
  })

  it('declines a star-only review below four stars rather than inventing a reply to nothing', async () => {
    const review = fixture('rev-1-star-only')
    const id = await recordAndRoute({
      rating: 1,
      comment: null,
      reviewerDisplayName: review.reviewerDisplayName,
      reviewedAtIso: review.createdAtIso,
    })
    const summary = await generateReplyDrafts(deps(deepseek()), { connectionId })
    expect(summary.outcomes[0]).toMatchObject({
      kind: 'no_draft',
      reason: 'no_skeleton_for_this_review',
    })
    const stored = await getReview(sql, id)
    expect(stored?.replyDraft).toBeNull()
    expect(stored?.draftQuarantineReason).toBe('no_skeleton_for_this_review')
  })
})

describe('acceptance — determinism across three runs', () => {
  it('yields a byte-identical draft for identical input in three separate agent runs', async () => {
    const review = fixture('rev-5-en')
    const ids: string[] = []
    for (let n = 0; n < 3; n += 1) {
      ids.push(
        await recordAndRoute({
          rating: review.rating,
          comment: review.comment ?? null,
          reviewerDisplayName: review.reviewerDisplayName,
          reviewedAtIso: review.createdAtIso,
        }),
      )
    }

    // Three runs, each drafting one row, each with its own provider instance — so neither the provider's
    // idempotency cache nor a shared closure can be what makes the answers agree.
    for (let n = 0; n < 3; n += 1) {
      const result = await withAgentRun(
        sql,
        { agentKey: AGENT_KEY, startedAtIso: NOW_ISO },
        async (charge) => {
          await generateReplyDrafts(deps(deepseek(), charge), { connectionId, limit: 1 })
        },
        createRunBudget,
      )
      expect(result.outcome, `run ${n}`).toBe('succeeded')
    }

    const drafts = await Promise.all(ids.map(async (id) => (await getReview(sql, id))?.replyDraft))
    expect(drafts.every((draft) => typeof draft === 'string' && draft.length > 0)).toBe(true)
    // The assertion the approval-queue screenshots depend on: one value, not three that look alike.
    expect(new Set(drafts).size).toBe(1)
    // And it is a house rendering, so there is nowhere a timestamp or an id could have got in.
    expect(isHouseReplyRendering(drafts[0] as string, 'en')).toBe(true)
  })

  it('writes no second draft when a run is replayed, so an owner edit is never overwritten', async () => {
    const review = fixture('rev-5-en')
    const id = await recordAndRoute({
      rating: review.rating,
      comment: review.comment ?? null,
      reviewerDisplayName: review.reviewerDisplayName,
      reviewedAtIso: review.createdAtIso,
    })
    await generateReplyDrafts(deps(deepseek()), { connectionId })
    const edited = 'Thank you for the rating. We look forward to welcoming you back.'
    await sql`update google_reviews set reply_draft = ${edited} where id = ${id}`
    const after = await auditCount('google_review.draft_recorded')

    // The row is no longer in the undrafted queue at all, which is the first line of defence.
    const replay = await generateReplyDrafts(deps(deepseek()), { connectionId })
    expect(replay.outcomes).toHaveLength(0)
    expect((await getReview(sql, id))?.replyDraft).toBe(edited)
    expect(await auditCount('google_review.draft_recorded')).toBe(after)
  })
})

describe('acceptance — a draft is written once, and a replay writes neither a row nor an audit', () => {
  it('answers already_drafted on a second call and writes no second audit row', async () => {
    // The queue read already keeps a drafted row out of the next run, so this asserts the guard the
    // repository itself carries — which is what holds when the read is stale, as it is for any
    // at-least-once job (docs/10 §7) and for two overlapping runs.
    const review = fixture('rev-5-en')
    const id = await recordAndRoute({
      rating: review.rating,
      comment: review.comment ?? null,
      reviewerDisplayName: review.reviewerDisplayName,
      reviewedAtIso: review.createdAtIso,
    })
    const input = {
      draft: 'Thank you for the rating. We look forward to welcoming you back.',
      skeletonId: 'positive_thanks',
      aspects: ['treatment'],
      language: 'en',
      promptVersion: 'g-rev-04-1',
      promptFingerprint: 'deadbeef',
      lintVersion: 'g-rev-04-house-draft-1',
    }
    expect(await withUnitOfWork(sql, AGENT, (uow) => recordReplyDraft(uow, id, input))).toBe(
      'drafted',
    )
    const after = await auditCount('google_review.draft_recorded')
    expect(await withUnitOfWork(sql, AGENT, (uow) => recordReplyDraft(uow, id, input))).toBe(
      'already_drafted',
    )
    expect(await auditCount('google_review.draft_recorded')).toBe(after)
  })

  it('answers already_decided on a second quarantine, and refuses a blank reason', async () => {
    const review = fixture('rev-3-mixed')
    const id = await recordAndRoute({
      rating: review.rating,
      comment: review.comment ?? null,
      reviewerDisplayName: review.reviewerDisplayName,
      reviewedAtIso: review.createdAtIso,
    })
    await expect(
      withUnitOfWork(sql, AGENT, (uow) => recordDraftQuarantine(uow, id, '   ')),
    ).rejects.toThrow(/needs the rule that refused the response/)
    expect(
      await withUnitOfWork(sql, AGENT, (uow) =>
        recordDraftQuarantine(uow, id, 'response_promises_money'),
      ),
    ).toBe('quarantined')
    const after = await auditCount('google_review.draft_quarantined')
    expect(
      await withUnitOfWork(sql, AGENT, (uow) =>
        recordDraftQuarantine(uow, id, 'response_admits_fault'),
      ),
    ).toBe('already_decided')
    expect(await auditCount('google_review.draft_quarantined')).toBe(after)
    // The first reason stands: a decision that was taken is the record of what the queue did.
    expect((await getReview(sql, id))?.draftQuarantineReason).toBe('response_promises_money')
  })
})

describe('acceptance — the 25-payload red-team corpus against the database', () => {
  it('produces no draft for any payload, and leaves every routing verdict exactly as it was', async () => {
    const quarantineBefore = await auditCount('google_review.draft_quarantined')
    const draftBefore = await auditCount('google_review.draft_recorded')
    const reviewer = fixture('rev-5-en').reviewerDisplayName

    for (const payload of RED_TEAM_CORPUS) {
      const id = await recordAndRoute({
        // Five stars for every payload: the rating is held constant so the only thing varying is the
        // attack. A five-star review is also the hardest case, because it is the only band docs/07 §4
        // would ever auto-send.
        rating: 5,
        comment: payload.reviewText,
        reviewerDisplayName: reviewer,
        reviewedAtIso: '2026-09-18T09:00:00.000Z',
      })
      const routedBefore = routingOf(await getReview(sql, id))

      const summary = await generateReplyDrafts(deps(obedientTo(payload.objective)), {
        connectionId,
        limit: 1,
      })
      expect(summary.outcomes, payload.id).toHaveLength(1)
      expect(summary.outcomes[0], payload.id).toMatchObject({
        kind: 'no_draft',
        reason: payload.expectedRefusal,
      })

      const stored = await getReview(sql, id)
      // No draft at all — so there is no draft for a linter to pass.
      expect(stored?.replyDraft, payload.id).toBeNull()
      expect(stored?.replyDraftSkeletonId, payload.id).toBeNull()
      expect(stored?.draftQuarantineReason, payload.id).toBe(payload.expectedRefusal)
      // The verdict is untouched. This is the criterion that matters most: a payload that moved it would
      // decide whether a human ever reads the review.
      expect(routingOf(stored), payload.id).toEqual(routedBefore)
      expect(routedBefore.verdict, payload.id).toBe('escalate')

      await sql`delete from google_reviews where id = ${id}`
    }

    // Deltas, counted in SQL: 25 quarantines and not one draft.
    expect(await auditCount('google_review.draft_quarantined')).toBe(quarantineBefore + 25)
    expect(await auditCount('google_review.draft_recorded')).toBe(draftBefore)
  })

  it('the control: an unhijacked model DOES draft for the same payloads, so the refusal is the defence', async () => {
    // Without this the assertion above would pass on a generator that never drafts anything.
    const payload = RED_TEAM_CORPUS[0]
    const id = await recordAndRoute({
      rating: 5,
      comment: payload?.reviewText ?? '',
      reviewerDisplayName: fixture('rev-5-en').reviewerDisplayName,
      reviewedAtIso: '2026-09-18T09:00:00.000Z',
    })
    const summary = await generateReplyDrafts(deps(deepseek()), { connectionId, limit: 1 })
    expect(summary.outcomes[0]?.kind).toBe('drafted')
    const stored = await getReview(sql, id)
    expect(isHouseReplyRendering(stored?.replyDraft ?? '', 'en')).toBe(true)
    // And the draft carries no byte of the payload, which membership of the closed set already implies.
    expect(stored?.replyDraft).not.toContain('IGNORE')
  })
})

describe('acceptance — the per-run token and cost caps from G-AGT-01', () => {
  it('aborts a run over the cap, records the partial cost in fils, and does NOT set last_success_at', async () => {
    const review = fixture('rev-5-en')
    for (let n = 0; n < 3; n += 1) {
      await recordAndRoute({
        rating: review.rating,
        // Distinct text per row, so each is a distinct prompt and a distinct charge.
        comment: `${review.comment ?? ''} Visit ${n}.`,
        reviewerDisplayName: review.reviewerDisplayName,
        reviewedAtIso: review.createdAtIso,
      })
    }

    const [heartbeatBefore] = await sql<{ last_success_at: Date | null }[]>`
      select last_success_at from agent_heartbeat where agent_key = ${AGENT_KEY}
    `
    // A cap that the first call fits inside and the second does not.
    await sql`update agent_definition set budget_fils_per_run = 1 where agent_key = ${AGENT_KEY}`

    const result = await withAgentRun(
      sql,
      { agentKey: AGENT_KEY, startedAtIso: NOW_ISO },
      async (charge) => {
        await generateReplyDrafts(
          // MiniMax, because it is the dearer of the two: the cap has to be reachable for the test to
          // be about the cap rather than about a provider that charges nothing.
          deps(
            createFakeMiniMax({ log: createCallLog(() => NOW_ISO), failures: new FailureScript() }),
            charge,
          ),
          { connectionId },
        )
      },
      createRunBudget,
    )

    expect(result.outcome).toBe('budget_exceeded')
    expect(result.error).toMatch(/budget exceeded/i)
    // The partial spend is persisted, in integer fils, so the month's bill is explainable by the runs
    // that caused it.
    const [run] = await sql<{ cost_fils: string; outcome: string }[]>`
      select cost_fils::text, outcome from agent_run where run_id = ${result.runId}::uuid
    `
    expect(run?.outcome).toBe('budget_exceeded')
    expect(Number.isInteger(Number(run?.cost_fils))).toBe(true)
    expect(Number(run?.cost_fils)).toBeGreaterThanOrEqual(0)
    expect(Number(run?.cost_fils)).toBeLessThanOrEqual(1)

    // THE criterion: the heartbeat records the attempt and the failure, and leaves the success alone.
    const [heartbeatAfter] = await sql<
      { last_success_at: Date | null; last_outcome: string; last_error: string | null }[]
    >`
      select last_success_at, last_outcome, last_error from agent_heartbeat where agent_key = ${AGENT_KEY}
    `
    expect(heartbeatAfter?.last_outcome).toBe('budget_exceeded')
    expect(heartbeatAfter?.last_error).toMatch(/budget exceeded/i)
    expect(heartbeatAfter?.last_success_at?.getTime() ?? null).toBe(
      heartbeatBefore?.last_success_at?.getTime() ?? null,
    )

    await sql`
      update agent_definition set budget_fils_per_run = ${seededBudgetFils} where agent_key = ${AGENT_KEY}
    `
  })

  it('the control: the same work under the seeded cap succeeds and DOES set last_success_at', async () => {
    const review = fixture('rev-5-en')
    await recordAndRoute({
      rating: review.rating,
      comment: review.comment ?? null,
      reviewerDisplayName: review.reviewerDisplayName,
      reviewedAtIso: review.createdAtIso,
    })
    const result = await withAgentRun(
      sql,
      { agentKey: AGENT_KEY, startedAtIso: NOW_ISO },
      async (charge) => {
        await generateReplyDrafts(
          deps(
            createFakeMiniMax({ log: createCallLog(() => NOW_ISO), failures: new FailureScript() }),
            charge,
          ),
          { connectionId },
        )
      },
      createRunBudget,
    )
    expect(result.outcome).toBe('succeeded')
    const [heartbeat] = await sql<{ last_success_at: Date | null }[]>`
      select last_success_at from agent_heartbeat where agent_key = ${AGENT_KEY}
    `
    expect(heartbeat?.last_success_at).not.toBeNull()
  })

  it('caps the output tokens on every request, which is the other half of the per-run cap', async () => {
    const review = fixture('rev-5-en')
    await recordAndRoute({
      rating: review.rating,
      comment: review.comment ?? null,
      reviewerDisplayName: review.reviewerDisplayName,
      reviewedAtIso: review.createdAtIso,
    })
    const summary = await generateReplyDrafts(deps(deepseek()), { connectionId })
    expect(summary.outputTokens).toBeGreaterThan(0)
    expect(summary.outputTokens).toBeLessThanOrEqual(120)
  })
})

describe('acceptance — the provider is selectable in settings', () => {
  it('switches the adapter with no code change, and the draft does not change with it', async () => {
    const review = fixture('rev-5-en')
    const first = await recordAndRoute({
      rating: review.rating,
      comment: review.comment ?? null,
      reviewerDisplayName: review.reviewerDisplayName,
      reviewedAtIso: review.createdAtIso,
    })

    const deepseekLog = createCallLog(() => NOW_ISO)
    await generateReplyDrafts(
      deps(createFakeDeepSeek({ log: deepseekLog, failures: new FailureScript() })),
      { connectionId, limit: 1 },
    )
    expect(deepseekLog.forProvider(DEEPSEEK).length).toBe(1)

    const second = await recordAndRoute({
      rating: review.rating,
      comment: review.comment ?? null,
      reviewerDisplayName: review.reviewerDisplayName,
      reviewedAtIso: review.createdAtIso,
    })
    const minimaxLog = createCallLog(() => NOW_ISO)
    await generateReplyDrafts(
      deps(createFakeMiniMax({ log: minimaxLog, failures: new FailureScript() })),
      { connectionId, limit: 1 },
    )
    expect(minimaxLog.forProvider(MINIMAX).length).toBe(1)

    // The adapter changed; the reply did not. That is the property that makes the switch safe to make:
    // the provider chooses which aspects, and the bytes are the house's either way.
    const one = (await getReview(sql, first))?.replyDraft
    const two = (await getReview(sql, second))?.replyDraft
    expect(one).toBe(two)
    expect(isHouseReplyRendering(one ?? '', 'en')).toBe(true)
  })

  it('validates the key against the provider BEFORE saving, and stores the choice when it passes', async () => {
    const providersFor = (name: string) =>
      name === MINIMAX
        ? createFakeMiniMax({ log: createCallLog(() => NOW_ISO), failures: new FailureScript() })
        : createFakeDeepSeek({ log: createCallLog(() => NOW_ISO), failures: new FailureScript() })

    await saveLlmProviderChoice(
      { sql, actor: OWNER, adapterFor: providersFor },
      { provider: MINIMAX, apiKey: ACCEPTED_KEY, role: 'owner', actorLabel: 'Owner' },
    )
    expect(await readSetting(sql, LLM_PROVIDER_SETTING_KEY)).toBe(MINIMAX)
  })

  it('refuses an invalid key with a readable message and leaves the setting exactly as it was', async () => {
    const providersFor = () =>
      createFakeDeepSeek({ log: createCallLog(() => NOW_ISO), failures: new FailureScript() })
    const before = await readSetting(sql, LLM_PROVIDER_SETTING_KEY)

    await expect(
      saveLlmProviderChoice(
        { sql, actor: OWNER, adapterFor: providersFor },
        {
          provider: DEEPSEEK,
          apiKey: `${ACCEPTED_KEY}${REJECTED_KEY_MARKER}`,
          role: 'owner',
          actorLabel: 'Owner',
        },
      ),
    ).rejects.toThrow(/well formed but deepseek does not recognise it/)

    // Unchanged. An invalid key that got stored is a silent agent two days later.
    expect(await readSetting(sql, LLM_PROVIDER_SETTING_KEY)).toBe(before)
  })

  it('refuses an empty key, and a provider name it has never heard of, without saving either', async () => {
    const providersFor = () =>
      createFakeDeepSeek({ log: createCallLog(() => NOW_ISO), failures: new FailureScript() })
    const before = await readSetting(sql, LLM_PROVIDER_SETTING_KEY)

    await expect(
      saveLlmProviderChoice(
        { sql, actor: OWNER, adapterFor: providersFor },
        { provider: DEEPSEEK, apiKey: '', role: 'owner', actorLabel: 'Owner' },
      ),
    ).rejects.toThrow(/API key is empty/)

    await expect(
      saveLlmProviderChoice(
        { sql, actor: OWNER, adapterFor: providersFor },
        { provider: 'gpt-9', apiKey: ACCEPTED_KEY, role: 'owner', actorLabel: 'Owner' },
      ),
    ).rejects.toThrow(/is not an LLM provider this build knows/)

    expect(await readSetting(sql, LLM_PROVIDER_SETTING_KEY)).toBe(before)
  })
})

describe('acceptance — a review in no configured language gets no draft', () => {
  it('records why rather than replying in a language nobody can check', async () => {
    // Tagalog: five stars, positive, and outside the configured set — the case docs/07 §4 row 4 names.
    const id = await recordAndRoute({
      rating: 5,
      comment: 'Napakaganda ng masahe at napakalinis ng lugar. Talagang inirerekomenda ko ito.',
      reviewerDisplayName: fixture('rev-4-star-only').reviewerDisplayName,
      reviewedAtIso: '2026-09-18T09:00:00.000Z',
    })
    const summary = await generateReplyDrafts(deps(deepseek()), { connectionId })
    expect(summary.outcomes[0]).toMatchObject({
      kind: 'no_draft',
      reason: 'reply_language_not_configured',
    })
    const stored = await getReview(sql, id)
    expect(stored?.replyDraft).toBeNull()
    expect(stored?.routingRuleId).toBe('language_outside_configured_set')
  })
})
