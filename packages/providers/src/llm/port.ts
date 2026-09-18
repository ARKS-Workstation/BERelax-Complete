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

export interface LlmProvider {
  readonly name: string
  complete(request: LlmRequest): Promise<LlmOutcome>
  /** Tokens spent so far, for the budget guard. */
  usage(): Promise<LlmUsage>
}
