/**
 * The LLM fake: deterministic responses, keyed on a hash of the prompt.
 *
 * Determinism is the whole point. A fake that returns varying text makes the screenshot harness
 * produce a pixel diff on every run, and makes the autoresponder's safety tests flaky — which trains
 * everyone to re-run them. Same prompt, same bytes, every time.
 *
 * It refuses the same things a real model refuses, because the refusal path is the one that matters
 * most here: a one-star review alleging a double charge must not receive an auto-drafted reply. Not
 * because a model would write something offensive, but because a public reply to an allegation about
 * money is a legal statement, and the correct behaviour is to put it in front of a person. The
 * routing that does so is tested against this fake, so it exists before the first real API key does.
 */
import type { CallLog } from '../call-log.ts'
import { type FailureScript, failureError } from '../failure.ts'
import type { LlmOutcome, LlmProvider, LlmRequest, LlmUsage } from './port.ts'

export const FAKE_LLM = 'fake-llm'

/**
 * Prompt content that draws a refusal.
 *
 * Deliberately about the *subject matter*, not about phrasing: an allegation of an unauthorised
 * charge, a claim of injury, or anything touching a legal process is a human's to answer. See
 * docs/07 §4 on safety routing.
 */
const REFUSAL_TRIGGERS: readonly { readonly pattern: RegExp; readonly reason: string }[] = [
  {
    pattern: /\b(charged|refund|double.?charg|fraud|stole|scam)\b/i,
    reason:
      'The review makes a factual allegation about money. A public reply is a statement about a ' +
      'disputed transaction and needs a human.',
  },
  {
    pattern: /\b(injur|hurt|burn|bruis|pain|allerg|infect)\w*/i,
    reason:
      'The review alleges physical harm. A public reply risks both a medical claim and an ' +
      'admission, and needs a human.',
  },
  {
    pattern: /\b(lawyer|legal|sue|court|police|authorit)\w*/i,
    reason:
      'The review raises a legal matter. Nothing goes out under the business name unreviewed.',
  },
]

/** FNV-1a. Small, dependency-free, and stable across runs and machines — which is all that is needed. */
function hash(text: string): number {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value
}

const REPLY_TEMPLATES = {
  en: [
    'Thank you for taking the time to share this. We are glad the visit worked for you, and we look forward to welcoming you back.',
    'Thank you for the kind words. We will pass them on to the team.',
    'Thank you for visiting us, and for the feedback. It is genuinely useful.',
  ],
  ar: [
    'شكراً لك على وقتك وكلماتك الطيبة. يسعدنا أن الزيارة كانت مريحة، ونتطلع إلى استقبالك مرة أخرى.',
    'نشكرك على تقييمك. سنشارك كلماتك مع الفريق.',
    'شكراً لزيارتك ولملاحظاتك، وهي مفيدة لنا حقاً.',
  ],
} as const

const SEO_TEMPLATES = [
  'The query "massage al zahiyah" sits at position 6.8 with 890 impressions and 6.1% CTR, and the page it lands on is the homepage. A dedicated area page would likely move it inside the top five.',
  'Two treatment pages rank on page two with four-figure impressions. Their titles do not carry the locality, which every competitor ranking above them does.',
  'Brand queries convert at 45% CTR and already sit at position 1.2. There is nothing to win there; the opportunity is entirely in the non-brand tail.',
] as const

export interface FakeLlmOptions {
  readonly log: CallLog
  readonly failures: FailureScript
}

export function createFakeLlm(options: FakeLlmOptions): LlmProvider {
  const { log, failures } = options
  const byIdempotencyKey = new Map<string, LlmOutcome>()
  let inputTokens = 0
  let outputTokens = 0

  /** Roughly four characters to a token. Close enough to make a budget guard testable. */
  const estimate = (text: string): number => Math.max(1, Math.ceil(text.length / 4))

  return {
    name: FAKE_LLM,

    async complete(request: LlmRequest): Promise<LlmOutcome> {
      const armed = failures.take()
      if (armed !== undefined) {
        log.record({
          provider: FAKE_LLM,
          operation: 'complete',
          outcome: 'failure',
          summary: `Completion for ${request.purpose} failed: ${armed}`,
          detail: { failureMode: armed, purpose: request.purpose },
        })
        throw failureError(FAKE_LLM, armed)
      }

      const replayed = byIdempotencyKey.get(request.idempotencyKey)
      if (replayed !== undefined) {
        log.record({
          provider: FAKE_LLM,
          operation: 'complete',
          outcome: 'success',
          summary: 'Cached completion returned; the budget is not spent twice',
          detail: { idempotencyKey: request.idempotencyKey, kind: replayed.kind },
        })
        return replayed
      }

      const input = estimate(request.prompt)
      inputTokens += input

      const trigger = REFUSAL_TRIGGERS.find((entry) => entry.pattern.test(request.prompt))
      if (trigger !== undefined) {
        const refusal: LlmOutcome = {
          kind: 'refusal',
          reason: trigger.reason,
          usage: { inputTokens: input, outputTokens: 0 },
        }
        byIdempotencyKey.set(request.idempotencyKey, refusal)
        log.record({
          provider: FAKE_LLM,
          operation: 'complete',
          outcome: 'success',
          summary: `Refused to draft a ${request.purpose}: ${trigger.reason}`,
          detail: { purpose: request.purpose, refused: true, inputTokens: input },
        })
        return refusal
      }

      const seed = hash(request.prompt)
      const replies = REPLY_TEMPLATES[request.locale]
      const text =
        request.purpose === 'review_reply'
          ? (replies[seed % replies.length] ?? '')
          : (SEO_TEMPLATES[seed % SEO_TEMPLATES.length] ?? '')

      const output = Math.min(estimate(text), request.maxOutputTokens)
      outputTokens += output

      const completion: LlmOutcome = {
        kind: 'completion',
        text,
        usage: { inputTokens: input, outputTokens: output },
      }
      byIdempotencyKey.set(request.idempotencyKey, completion)

      log.record({
        provider: FAKE_LLM,
        operation: 'complete',
        outcome: 'success',
        summary: `Drafted a ${request.purpose} in ${request.locale}, ${output} output token(s)`,
        detail: {
          purpose: request.purpose,
          locale: request.locale,
          promptHash: seed,
          inputTokens: input,
          outputTokens: output,
        },
      })
      return completion
    },

    async usage(): Promise<LlmUsage> {
      return { inputTokens, outputTokens }
    },
  }
}
