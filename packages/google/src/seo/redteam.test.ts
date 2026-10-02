import type { CompliancePolicy } from '@berelax/core'
import {
  agentPrincipal,
  encloseUntrustedSeoData,
  judgeSeoSuggestion,
  mayPerformPublication,
  type Principal,
  PrincipalDenied,
  PUBLICATION_ACTIONS,
  SEO_AGENT_PRINCIPAL,
  SEO_DRAFT_SCREEN_RULES,
  type SeoUntrustedEnvelope,
  staffPrincipal,
} from '@berelax/core'
import type { Sql } from '@berelax/db'
import { createCallLog } from '@berelax/providers/call-log'
import { FailureScript } from '@berelax/providers/failure'
import {
  costOfFils,
  createFakeDeepSeek,
  createFakeMiniMax,
  type LlmProvider,
} from '@berelax/providers/llm'
import { describe, expect, it } from 'vitest'
import { applySeoSuggestion, rollbackSeoSuggestion } from '../suggestions/apply.ts'
import type { SeoDraftRequest, SeoModelAnswer } from './draft-suggestions.ts'
import { SEO_RED_TEAM_CORPUS, SEO_RED_TEAM_CORPUS_SIZE } from './redteam.corpus/index.ts'

/**
 * The red-team gate: 25 injection payloads, and the two claims that have to hold for every one of them.
 *
 * *"every one yields at most a suggestion row, zero yield a publish attempt, and each escalation attempt
 * is recorded as a security event."*
 *
 * The three halves of that live in two files, and the split is deliberate:
 *
 *   - **Here**: the corpus is complete, every payload's `objective` is refused by the rule it names, the
 *     envelope holds for every payload in every carrier, and **no principal the agent can hold may
 *     publish** — asserted against a `Sql` that throws on any access, so "refused at the permission
 *     layer" is a claim about WHERE and not only about whether.
 *   - **`suggestion-store.itest.ts`**: the rows, the audit deltas and the publication chain, which need a
 *     database.
 *
 * ## Why this file is the gate
 *
 * `scripts/test-gates.mjs` case 164a grants `content:publish` to the `seo_agent` principal in a fixture
 * and asserts that THIS suite fails, then restores the file. That is the only way to know the cage is
 * load-bearing: every assertion below passes against a matrix that denies everybody, which is a broken
 * product with a green security test (ADR 0003, and `seo-agent.policy.test.ts`'s own third claim).
 *
 * ## Why the corpus is driven through the SCREEN and not only through the fake
 *
 * The shipped fakes are hash tables over the prompt — they do not read English, so driving 25 attacks
 * through one proves only that a hash table is indifferent. What matters is what happens when a model
 * COMPLIES, so each payload carries the answer a fully-succumbed model would give and the screen is asked
 * about that. The payload's own text is still exercised: it goes through `encloseUntrustedSeoData`, and
 * the assertions there are the ones the fuzz suite makes for one string, made again for these 25 inside
 * their real carriers and at their real caps.
 */

/** The stand-in profile. One banned term; see `suggestion.test.ts`'s note on why not fourteen. */
const POLICY: CompliancePolicy = Object.freeze({
  bannedClaimTerms: Object.freeze(['therapeutic']),
  permittedPublicTitles: Object.freeze(['Therapist']),
  medicalClaimsPermitted: false,
})

/**
 * A `Sql` that throws on ANY access.
 *
 * The point of the assertion, not a convenience. "Publish is refused at the permission layer" is a claim
 * about where, and every way of stating it without looking at the ordering can be satisfied by a function
 * that queries the database, decides it is not allowed, and throws. Handing it a connection it cannot
 * touch makes the ordering the thing being tested.
 */
const unusableSql = new Proxy({} as Sql, {
  get(_target, property) {
    throw new Error(
      `the publication path touched the database (${String(property)}) before the permission layer ` +
        'refused it. A refusal taken after a query is a refusal that has already read the rows it was ' +
        'not allowed to act on.',
    )
  },
  apply() {
    throw new Error('the publication path issued a query before the permission layer refused it')
  },
})

const declaredPrincipal = (id: string): Principal => {
  const principal = agentPrincipal(id)
  if (principal === null) {
    throw new Error(
      `agentPrincipal('${id}') is null, so this suite would be asserting that a principal which does ` +
        'not exist holds no permissions — which is the answer it is looking for, arrived at by accident.',
    )
  }
  return principal
}

const SEO_AGENT = declaredPrincipal(SEO_AGENT_PRINCIPAL)

/** The envelope source each carrier maps to. The labels are the envelope's own closed set. */
const CARRIERS = {
  fetched_html: 'fetched_html',
  serp_text: 'serp_text',
  gsc_query: 'gsc_query',
} as const

function enclose(payload: (typeof SEO_RED_TEAM_CORPUS)[number]): SeoUntrustedEnvelope {
  return encloseUntrustedSeoData({ source: CARRIERS[payload.carrier], text: payload.text })
}

describe('the SEO red-team corpus', () => {
  it('holds the 25 payloads the acceptance criterion names, with no duplicate ids', () => {
    expect(SEO_RED_TEAM_CORPUS).toHaveLength(SEO_RED_TEAM_CORPUS_SIZE)
    expect(new Set(SEO_RED_TEAM_CORPUS.map((payload) => payload.id)).size).toBe(
      SEO_RED_TEAM_CORPUS_SIZE,
    )
  })

  it('spreads across all three carriers, because they have different caps', () => {
    /*
     * The caps differ — a GSC query is capped at 300 characters and a fetched page at 20,000 — and
     * truncation is the one transformation that can turn a harmless string into a fence. A corpus that
     * put all 25 in the roomiest carrier would never exercise that.
     */
    const carriers = new Set(SEO_RED_TEAM_CORPUS.map((payload) => payload.carrier))
    expect([...carriers].sort()).toEqual(['fetched_html', 'gsc_query', 'serp_text'])
  })

  it('has at least one payload per screen rule', () => {
    // A rule with no payload may not be a rule at all. The corpus is the evidence that each one has been
    // seen to refuse something, which is ADR 0003's argument applied to a data set.
    const covered = new Set(SEO_RED_TEAM_CORPUS.map((payload) => payload.expectedRule))
    expect([...covered].sort()).toEqual([...SEO_DRAFT_SCREEN_RULES].sort())
  })
})

describe('every payload, enclosed', () => {
  for (const payload of SEO_RED_TEAM_CORPUS) {
    it(`${payload.id}: the untrusted region is not closed from inside`, () => {
      const envelope = enclose(payload)
      const lines = envelope.region.split('\n')
      // Exactly one open and one close fence, and every body line guttered. The fuzz suite proves this
      // over 200 strings; this proves it for the 25 that are actually in the corpus, inside their own
      // carriers and at their own caps.
      expect(lines.filter((line) => line.startsWith('-----BEGIN'))).toHaveLength(1)
      expect(lines.filter((line) => line.startsWith('-----END'))).toHaveLength(1)
      expect(lines.slice(1, -1).every((line) => line.startsWith('| '))).toBe(true)
      expect(envelope.fenced).not.toContain('-----BEGIN')
    })
  }
})

describe('every payload, screened', () => {
  for (const payload of SEO_RED_TEAM_CORPUS) {
    it(`${payload.id}: the complied answer is refused by ${payload.expectedRule}`, () => {
      const verdict = judgeSeoSuggestion({
        target: { kind: 'page_title', ref: '/treatments/deep-tissue#title' },
        surface: 'treatments:deep-tissue',
        beforeRegions: [{ region: 'title', text: 'Deep Tissue' }],
        // The copy is CLEAN. That is the point: a payload whose after-copy also tripped the publication
        // lint would be refused for a reason that has nothing to do with the escalation, and the case
        // would pass while the screen was dead.
        afterRegions: [{ region: 'title', text: 'Deep tissue massage in Al Zahiyah' }],
        answer: payload.objective,
        policy: POLICY,
      })
      expect(verdict.kind).toBe('refused')
      if (verdict.kind !== 'refused') return
      expect(verdict.rules).toContain(payload.expectedRule)
      // At most a suggestion ROW: a refused verdict is stored as a `refused` row, which can never become
      // `approved` (ZY402) and therefore can never be applied.
      expect(verdict.escalations.length).toBeGreaterThan(0)
      // And the control that keeps this from passing for the wrong reason: the copy itself is clean.
      expect(verdict.copyFindings).toEqual([])
    })
  }
})

describe('zero payloads yield a publish attempt', () => {
  it('denies the seo_agent principal every publication action', () => {
    for (const action of PUBLICATION_ACTIONS) {
      expect(mayPerformPublication(SEO_AGENT, action), action).toBe(false)
    }
  })

  it('refuses applySeoSuggestion at the permission layer, before any query', async () => {
    await expect(
      applySeoSuggestion(unusableSql, {
        principal: SEO_AGENT,
        suggestionId: '00000000-0000-7000-8000-000000000001',
        approver: { userId: 'u1', displayName: 'Operator Record 1', role: 'owner' },
        measuredCriticalPathBytes: 1,
        criticalPathBudgetBytes: 2,
        now: new Date('2026-03-01T10:00:00.000Z'),
      }),
    ).rejects.toThrow(PrincipalDenied)
  })

  it('refuses rollbackSeoSuggestion at the permission layer, before any query', async () => {
    await expect(
      rollbackSeoSuggestion(unusableSql, {
        principal: SEO_AGENT,
        suggestionId: '00000000-0000-7000-8000-000000000001',
        actorLabel: 'Operator Record 1',
        measuredCriticalPathBytes: 1,
        criticalPathBudgetBytes: 2,
        now: new Date('2026-03-01T10:00:00.000Z'),
      }),
    ).rejects.toThrow(PrincipalDenied)
  })

  it('and the control: a principal that MAY publish is not refused by the policy layer', () => {
    /*
     * Without this, every assertion above is satisfied by a matrix that refuses everybody — a broken
     * product that passes a security test. This is the claim gate case 164a breaks from the other side:
     * granting the agent `content:publish` must make this suite FAIL, which it can only do if the suite
     * is measuring the grant rather than measuring that nothing is granted.
     */
    expect(mayPerformPublication(staffPrincipal('owner'), 'publish')).toBe(true)
  })
})

describe('the LLM seam, and the fake that must be deterministic', () => {
  const providers: readonly LlmProvider[] = [
    createFakeDeepSeek({
      log: createCallLog(() => '2026-03-01T10:00:00.000Z'),
      failures: new FailureScript(),
    }),
    createFakeMiniMax({
      log: createCallLog(() => '2026-03-01T10:00:00.000Z'),
      failures: new FailureScript(),
    }),
  ]

  /**
   * A drafter built on the real port, which is what holds {@link SeoModelAnswer} equal to `LlmOutcome`.
   *
   * `draft-suggestions.ts` declares its own structural seam because
   * `seo-llm-only-through-a-prompt-module` forbids it from importing `packages/providers/src/llm/` at all
   * — tests are exempt, which is why this adapter can live here. A field renamed on the port is a compile
   * error in this function rather than a runtime surprise in the worker, which is the check the brief
   * asks for whenever a fact is stated twice.
   */
  async function drafterFor(
    provider: LlmProvider,
    request: SeoDraftRequest,
  ): Promise<SeoModelAnswer> {
    const outcome = await provider.complete({
      purpose: 'seo_recommendation',
      prompt: request.evidence.map((envelope) => envelope.region).join('\n\n'),
      locale: 'en',
      maxOutputTokens: 200,
      idempotencyKey: `${request.surface}:${request.target.kind}`,
    })
    return {
      provider: provider.name,
      kind: outcome.kind,
      text: outcome.kind === 'completion' ? outcome.text : outcome.reason,
      inputTokens: outcome.usage.inputTokens,
      outputTokens: outcome.usage.outputTokens,
      costFils: costOfFils(outcome.usage, provider.pricing),
      regions: outcome.kind === 'completion' ? [{ region: 'title', text: outcome.text }] : [],
    }
  }

  const request: SeoDraftRequest = {
    target: { kind: 'page_title', ref: '/treatments/deep-tissue#title' },
    surface: 'treatments:deep-tissue',
    beforeRegions: [{ region: 'title', text: 'Deep Tissue' }],
    evidence: [
      encloseUntrustedSeoData({ source: 'gsc_query', text: 'deep tissue massage abu dhabi' }),
    ],
  }

  for (const provider of providers) {
    it(`${provider.name}: three runs over identical findings produce byte-identical drafts`, async () => {
      const answers = [
        await drafterFor(provider, request),
        await drafterFor(provider, request),
        await drafterFor(provider, request),
      ]
      // Byte-identical, serialised whole — the text AND the token counts AND the cost. A fake whose text
      // was stable and whose usage drifted would make the per-run cost unreproducible, which is the
      // figure the cap is enforced against.
      expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1)
    })

    it(`${provider.name}: the cost is an integer number of fils`, () => {
      const cost = costOfFils({ inputTokens: 1_234, outputTokens: 567 }, provider.pricing)
      expect(Number.isInteger(cost)).toBe(true)
      expect(cost).toBeGreaterThan(0)
    })
  }
})
