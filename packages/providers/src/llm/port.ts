import { AppError } from '@berelax/shared'

/**
 * The LLM port.
 *
 * Two consumers, with opposite risk profiles. The **review autoresponder** writes text that appears
 * under the business's name on a public Google profile; the **SEO agent** writes recommendations a
 * human reads before acting. Both go through this interface, and the difference is handled by the
 * routing around it, not by two clients.
 *
 * Shaped around what actually matters operationally rather than around any one vendor's SDK:
 *
 * - **Token accounting is part of the response**, because the monthly budget is a bounded setting
 *   (`agents.monthly_token_budget`) and a budget nobody measures is a number in a document.
 * - **A refusal is a normal outcome**, not an exception. A model declining to draft a reply to a
 *   review alleging a double charge is the model behaving correctly, and the autoresponder must route
 *   it to a human rather than retry it.
 * - **The prompt carries its purpose.** What a draft is for decides whether it may be sent without
 *   review, so the decision is made from data rather than from which call site produced it.
 */

export type LlmPurpose = 'review_reply' | 'seo_recommendation' | 'copy_suggestion'

export interface LlmRequest {
  readonly purpose: LlmPurpose
  readonly prompt: string
  /** Sets the reply's language; a review in Arabic is answered in Arabic. */
  readonly locale: 'en' | 'ar'
  readonly maxOutputTokens: number
  /** Deduplication key, so a retried job does not spend the budget twice. */
  readonly idempotencyKey: string
}

export type LlmOutcome =
  | { readonly kind: 'completion'; readonly text: string; readonly usage: LlmUsage }
  /** The model declined. The caller escalates; it does not rephrase and retry. */
  | { readonly kind: 'refusal'; readonly reason: string; readonly usage: LlmUsage }

export interface LlmUsage {
  readonly inputTokens: number
  readonly outputTokens: number
}

/**
 * What one call costs, in **integer fils** (ADR 0007).
 *
 * Per million tokens, because that is the unit every vendor prices in, and the conversion to fils for a
 * single call is a rounding decision that must be made in one place. `costOfFils` does it and rounds
 * **up**, because a run that under-reports its own cost is a per-run cap that does not hold: the
 * shortfall accumulates inside one run, which is precisely the runaway the cap exists to stop.
 */
export interface LlmPricing {
  readonly inputFilsPerMillionTokens: number
  readonly outputFilsPerMillionTokens: number
}

export interface LlmProvider {
  readonly name: string
  complete(request: LlmRequest): Promise<LlmOutcome>
  /** Tokens spent so far, for the budget guard. */
  usage(): Promise<LlmUsage>
  /**
   * Refuses a key this provider will not accept, **before** it is saved.
   *
   * Asynchronous because the authoritative answer comes from the provider: a real adapter probes the
   * vendor's cheapest endpoint with the key, which is the only check that distinguishes a well-formed
   * key from a live one. Throws `AppError('validation', ...)` with a message an owner can act on —
   * never a boolean, because a boolean forces every caller to invent the sentence.
   */
  validateKey(key: string): Promise<void>
  /** What this provider charges. Read by the caller to convert a usage into fils. */
  readonly pricing: LlmPricing
}

/**
 * A usage as integer fils, rounded up.
 *
 * Exported here rather than in `core` because pricing is a fact about a provider and this is the module
 * that owns provider facts. `Math.ceil` on the total rather than per-component: two ceilings would
 * charge two fils for a call that cost a fraction of one.
 */
export function costOfFils(usage: LlmUsage, pricing: LlmPricing): number {
  const micro =
    usage.inputTokens * pricing.inputFilsPerMillionTokens +
    usage.outputTokens * pricing.outputFilsPerMillionTokens
  return Math.ceil(micro / 1_000_000)
}

/**
 * The shortest key any of these vendors issues.
 *
 * A floor rather than a format. Twenty characters is below every published key length and above every
 * paste accident, which is the whole job of a local check: refuse the two mistakes that need no round
 * trip — an empty box and a key with a newline in it — and let the provider answer everything else.
 */
export const MINIMUM_LLM_KEY_LENGTH = 20

/**
 * The local half of key validation. Throws a sentence an owner can act on.
 *
 * Exported so the settings save path can refuse the two cheap cases before it opens a socket, and so a
 * test can assert the message rather than a boolean.
 */
export function validateLlmKey(provider: string, key: unknown): void {
  if (typeof key !== 'string' || key.trim().length === 0) {
    throw new AppError(
      'validation',
      `The ${provider} API key is empty. Paste the key from the ${provider} console before saving.`,
      { details: { provider } },
    )
  }
  if (/\s/.test(key)) {
    throw new AppError(
      'validation',
      `The ${provider} API key contains a space or a line break, which usually means the copy picked ` +
        'up surrounding text. Paste the key on its own.',
      { details: { provider } },
    )
  }
  if (key.length < MINIMUM_LLM_KEY_LENGTH) {
    throw new AppError(
      'validation',
      `The ${provider} API key is ${key.length} characters, shorter than any key ${provider} issues ` +
        `(at least ${MINIMUM_LLM_KEY_LENGTH}). Check it was copied in full.`,
      { details: { provider, length: key.length } },
    )
  }
}
