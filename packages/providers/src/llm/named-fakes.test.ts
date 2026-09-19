import { parseConfig } from '@berelax/config'
import {
  assembleReplyDraft,
  buildReviewReplyPrompt,
  INSTRUCTIONS,
  isHouseReplyRendering,
} from '@berelax/core'
import { isAppError } from '@berelax/shared'
import { beforeEach, describe, expect, it } from 'vitest'
import { createProviders, type Providers } from '../registry.ts'
import {
  DEEPSEEK,
  MINIMAX,
  PROVISIONAL_DEEPSEEK_PRICING,
  PROVISIONAL_MINIMAX_PRICING,
  REJECTED_KEY_MARKER,
} from './named-fakes.ts'
import { costOfFils, type LlmProvider, MINIMUM_LLM_KEY_LENGTH } from './port.ts'

/**
 * The two named LLM fakes: selection is configuration, the key is validated before saving, and cost is
 * integer fils.
 *
 * ## No credential appears in this file
 *
 * Every key below contains the word `fake` or a run of zeros, which is what `pnpm secrets`'s placeholder
 * vocabulary recognises — and, more to the point, what a human recognises. A test needing "a valid key"
 * is where a plausible credential gets invented, and a plausible credential is indistinguishable from a
 * real one to a leak scanner and to the next reader.
 */

const CLOCK = '2026-09-18T10:00:00.000Z'

/** Long enough to pass the length floor, and visibly not a credential. */
const ACCEPTED_KEY = 'fake-key-for-tests-0000000000'
/** The same, with the marker the fake's probe rejects. */
const REJECTED_KEY = `fake-key-for-tests-0000000000${REJECTED_KEY_MARKER}`

const SELECTION_PROMPT = [
  'REPLY_LANGUAGE: en',
  'ALLOWED_ASPECTS: treatment, team, cleanliness, atmosphere, welcome, booking, value, location',
  'Select the aspects the reviewer cared about.',
].join('\n')

let providers: Providers

beforeEach(() => {
  providers = createProviders({
    config: parseConfig({ APP_ENV: 'test', DATABASE_URL: 'postgres://localhost/berelax_test' }),
    now: () => CLOCK,
  })
})

describe('provider selection is a setting, not a code change', () => {
  it('resolves each declared name to its own adapter', () => {
    expect(providers.llmFor('deepseek').name).toBe(DEEPSEEK)
    expect(providers.llmFor('minimax').name).toBe(MINIMAX)
    expect(providers.llmFor('fake').name).toBe('fake-llm')
  })

  it('switching from DeepSeek to MiniMax changes the adapter, the log and the price', async () => {
    const request = {
      purpose: 'review_reply',
      prompt: SELECTION_PROMPT,
      locale: 'en',
      maxOutputTokens: 200,
      idempotencyKey: 'switch-1',
    } as const

    const deepseek = await providers.llmFor('deepseek').complete(request)
    const minimax = await providers
      .llmFor('minimax')
      .complete({ ...request, idempotencyKey: 's-2' })

    expect(deepseek.kind).toBe('completion')
    expect(minimax.kind).toBe('completion')
    // Each wrote to its own name in the one visible outbox, which is how an operator sees which
    // provider actually answered.
    expect(providers.calls.forProvider(DEEPSEEK).length).toBe(1)
    expect(providers.calls.forProvider(MINIMAX).length).toBe(1)
    // And they charge differently, so a cost recorded against a run says which provider produced it.
    expect(PROVISIONAL_MINIMAX_PRICING.outputFilsPerMillionTokens).toBeGreaterThan(
      PROVISIONAL_DEEPSEEK_PRICING.outputFilsPerMillionTokens,
    )
  })

  it('both answer in their own manner and both are understood, which is the point of the switch', async () => {
    const request = {
      purpose: 'review_reply',
      prompt: SELECTION_PROMPT,
      locale: 'en',
      maxOutputTokens: 200,
      idempotencyKey: 'manner-1',
    } as const
    const deepseek = await providers.llmFor('deepseek').complete(request)
    const minimax = await providers
      .llmFor('minimax')
      .complete({ ...request, idempotencyKey: 'm-2' })
    if (deepseek.kind !== 'completion' || minimax.kind !== 'completion') {
      expect.unreachable('both fakes complete')
      return
    }
    // Different bytes...
    expect(deepseek.text).not.toBe(minimax.text)
    // ...and DeepSeek's is the exact requested form while MiniMax's is a sentence around it. A consumer
    // that only worked against the first would break on the switch.
    expect(deepseek.text.startsWith('ASPECTS: ')).toBe(true)
    expect(minimax.text.startsWith('ASPECTS: ')).toBe(false)
  })

  it('refuses a name it has no adapter for, rather than substituting one', () => {
    // 'claude' is a declared setting value with nothing behind it. Quietly using the local fake would
    // generate drafts with a provider the owner did not choose.
    expect(() => providers.llmFor('claude')).toThrow(/no adapter has been built/)
    expect(() => providers.llmFor('gpt-9')).toThrow(/not one of/)
    expect(() => providers.llmFor(undefined)).toThrow(/not one of/)
    expect(() => providers.llmFor(null)).toThrow(/not one of/)
    expect(() => providers.llmFor(42)).toThrow(/not one of/)
  })

  it('names the providers that do work, so the refusal is actionable', () => {
    try {
      providers.llmFor('claude')
      expect.unreachable('claude has no adapter')
    } catch (error) {
      expect(isAppError(error)).toBe(true)
      expect(String(error)).toContain('deepseek')
      expect(String(error)).toContain('minimax')
    }
  })

  it('selects deterministically: the same prompt draws the same answer every time', async () => {
    const answers = await Promise.all(
      [1, 2, 3].map((n) =>
        providers.llmFor('deepseek').complete({
          purpose: 'review_reply',
          prompt: SELECTION_PROMPT,
          locale: 'en',
          maxOutputTokens: 200,
          // A different idempotency key each time, so this is determinism rather than the cache.
          idempotencyKey: `determinism-${n}`,
        }),
      ),
    )
    const texts = answers.map((answer) => (answer.kind === 'completion' ? answer.text : 'refused'))
    expect(new Set(texts).size).toBe(1)
  })

  it('never selects an aspect the prompt did not offer', async () => {
    const answer = await providers.llmFor('minimax').complete({
      purpose: 'review_reply',
      prompt: 'REPLY_LANGUAGE: en\nALLOWED_ASPECTS: treatment\nSelect.',
      locale: 'en',
      maxOutputTokens: 200,
      idempotencyKey: 'narrow-1',
    })
    if (answer.kind !== 'completion') {
      expect.unreachable('the fake completes')
      return
    }
    expect(answer.text).toContain('treatment')
    for (const other of ['team', 'cleanliness', 'atmosphere', 'welcome', 'booking', 'value']) {
      expect(answer.text).not.toContain(other)
    }
  })
})

describe('the key is validated against the provider before saving', () => {
  it('accepts a well-formed key the provider recognises, and records the check', async () => {
    await expect(providers.llmFor('deepseek').validateKey(ACCEPTED_KEY)).resolves.toBeUndefined()
    const recorded = providers.calls.forProvider(DEEPSEEK)
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.outcome).toBe('success')
    // The key is never in the outbox. A visible local outbox is not a place for a credential.
    expect(JSON.stringify(recorded[0])).not.toContain(ACCEPTED_KEY)
  })

  it('refuses an empty key with a readable message', async () => {
    await expect(providers.llmFor('deepseek').validateKey('')).rejects.toThrow(
      /API key is empty\. Paste the key/,
    )
    await expect(providers.llmFor('deepseek').validateKey('   ')).rejects.toThrow(/is empty/)
  })

  it('refuses a key that picked up surrounding text, which is the commonest paste error', async () => {
    await expect(
      providers.llmFor('deepseek').validateKey(`${ACCEPTED_KEY}\nDEEPSEEK_API_KEY=`),
    ).rejects.toThrow(/space or a line break/)
  })

  it('refuses a key shorter than any provider issues, naming the length', async () => {
    await expect(providers.llmFor('minimax').validateKey('fake-000')).rejects.toThrow(
      new RegExp(
        `8 characters, shorter than any key minimax issues \\(at least ${MINIMUM_LLM_KEY_LENGTH}\\)`,
      ),
    )
  })

  it('refuses a well-formed key the PROVIDER does not recognise, and says which is which', async () => {
    // The distinction that matters: this key passes every local check. Only the provider can answer,
    // which is why `validateKey` is asynchronous and why the real adapter probes an endpoint.
    await expect(providers.llmFor('minimax').validateKey(REJECTED_KEY)).rejects.toThrow(
      /well formed but minimax does not recognise it/,
    )
    const recorded = providers.calls.forProvider(MINIMAX)
    expect(recorded[0]?.outcome).toBe('failure')
    expect(JSON.stringify(recorded[0])).not.toContain(REJECTED_KEY)
  })

  it('surfaces a provider outage as an outage, not as an invalid key', async () => {
    // An owner told "your key is invalid" when the provider is down changes a key that was fine, and
    // then cannot get back the one that worked.
    providers.failures.failNext('server_error')
    await expect(providers.llmFor('deepseek').validateKey(ACCEPTED_KEY)).rejects.toThrow(
      /internal error/,
    )
  })

  it('the default local fake validates too, so the save path is testable against it', async () => {
    await expect(providers.llm.validateKey(ACCEPTED_KEY)).resolves.toBeUndefined()
    await expect(providers.llm.validateKey('')).rejects.toThrow(/is empty/)
  })
})

describe('cost is integer fils, rounded up', () => {
  it('converts a usage at the provider price', () => {
    // 1,000,000 input tokens at 500 fils per million is 500 fils. Exact, so the arithmetic is visible.
    expect(
      costOfFils({ inputTokens: 1_000_000, outputTokens: 0 }, PROVISIONAL_DEEPSEEK_PRICING),
    ).toBe(500)
    expect(
      costOfFils({ inputTokens: 0, outputTokens: 1_000_000 }, PROVISIONAL_DEEPSEEK_PRICING),
    ).toBe(2_000)
  })

  it('rounds a fraction of a fils UP, because a run that under-reports is a cap that does not hold', () => {
    const cost = costOfFils({ inputTokens: 1, outputTokens: 1 }, PROVISIONAL_DEEPSEEK_PRICING)
    expect(cost).toBe(1)
    expect(Number.isInteger(cost)).toBe(true)
  })

  it('is zero only for a provider that charges nothing', () => {
    expect(costOfFils({ inputTokens: 0, outputTokens: 0 }, PROVISIONAL_MINIMAX_PRICING)).toBe(0)
    expect(costOfFils({ inputTokens: 500, outputTokens: 500 }, providers.llm.pricing)).toBe(0)
  })

  it('the same usage costs more on MiniMax than on DeepSeek, so the switch is visible in the bill', () => {
    const usage = { inputTokens: 2_000, outputTokens: 400 }
    expect(costOfFils(usage, PROVISIONAL_MINIMAX_PRICING)).toBeGreaterThan(
      costOfFils(usage, PROVISIONAL_DEEPSEEK_PRICING),
    )
  })
})

describe('every adapter drafts through the REAL prompt, including the default one', () => {
  /**
   * The regression this block exists for, and it was a live defect.
   *
   * `agents.llm_provider` defaults to `fake`, so the local adapter is the one every developer and every
   * CI run uses. `createFakeLlm` matched its refusal triggers against the WHOLE prompt, and G-REV-04's
   * instruction section forbids mentioning a refund — so it contains the word "refund", so the fake
   * refused **every** review-reply prompt and the autoresponder quarantined 100% of reviews as
   * `response_absent`. Nothing threw and nothing logged an error; the approval queue simply filled with
   * a reason that made it look as though the model had nothing to say.
   *
   * Driving each adapter's real answer through the real prompt and the real assembler is the only test
   * shape that would have caught it: every part in isolation was correct.
   */
  const REVIEWS: readonly { readonly text: string; readonly language: 'en' | 'ar' }[] = [
    {
      text: 'Best massage in Abu Dhabi. Very professional and the place is spotless.',
      language: 'en',
    },
    { text: 'مكان ممتاز ونظيف، والخدمة رائعة. أنصح به بشدة.', language: 'ar' },
  ]

  const draftWith = async (adapter: LlmProvider, index: number) => {
    const review = REVIEWS[index] as (typeof REVIEWS)[number]
    const prompt = buildReviewReplyPrompt({
      rating: 5,
      commentText: review.text,
      language: review.language,
      skeleton: 'positive_thanks',
    })
    const outcome = await adapter.complete({
      purpose: 'review_reply',
      prompt: prompt.text,
      locale: review.language,
      maxOutputTokens: 120,
      idempotencyKey: `${adapter.name}-${index}`,
    })
    return {
      review,
      outcome,
      draft: assembleReplyDraft({
        rating: 5,
        commentText: review.text,
        language: review.language,
        prompt,
        response: outcome.kind === 'completion' ? outcome.text : null,
      }),
    }
  }

  it('the instruction section really does contain the trigger word, so this is not hypothetical', () => {
    // If the instructions stop forbidding a refund by name, this assertion fails and whoever reads it
    // learns that the regression below is no longer reachable — rather than the test quietly proving
    // nothing.
    expect(INSTRUCTIONS).toContain('refund')
  })

  for (const name of ['fake', 'deepseek', 'minimax'] as const) {
    for (const index of [0, 1]) {
      it(`${name} drafts a house reply for the ${index === 0 ? 'English' : 'Arabic'} review`, async () => {
        const { review, outcome, draft } = await draftWith(providers.llmFor(name), index)
        expect(outcome.kind, `${name} refused a benign review`).toBe('completion')
        expect(draft.kind, `${name} produced no draft`).toBe('drafted')
        if (draft.kind !== 'drafted') return
        expect(isHouseReplyRendering(draft.draft, review.language)).toBe(true)
      })
    }
  }

  it('the control: the local fake still refuses when the REVIEW alleges a double charge', async () => {
    // Scoping the trigger to the untrusted region must not have switched the trigger off. The words are
    // now inside the review rather than the instructions, which is where they mean something.
    const prompt = buildReviewReplyPrompt({
      rating: 1,
      commentText: 'They charged my card twice and refused to refund. Avoid.',
      language: 'en',
      skeleton: 'low_rating_acknowledgement',
    })
    const outcome = await providers.llm.complete({
      purpose: 'review_reply',
      prompt: prompt.text,
      locale: 'en',
      maxOutputTokens: 120,
      idempotencyKey: 'refusal-still-fires',
    })
    expect(outcome.kind).toBe('refusal')
    if (outcome.kind === 'refusal') expect(outcome.reason).toMatch(/money/i)
  })
})
