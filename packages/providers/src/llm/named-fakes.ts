/**
 * The DeepSeek and MiniMax fakes — the two candidates docs/07 §4 names.
 *
 * ## Why two named fakes rather than one generic one
 *
 * "Provider selectable in settings" (docs/07 §4) is only a real claim if switching actually changes
 * something. `createFakeLlm` is a single adapter, so a test that "switched provider" against it would be
 * asserting that a string changed. These two differ in the three ways a real pair differs and that the
 * consumer has to cope with: the **name** that lands in the call log, the **price** it charges, and the
 * **response protocol** it answers in. Switching is then observable without any code change, which is
 * what H02's contract ("provider selection is config only") means operationally.
 *
 * ## The response protocol, and why the two fakes answer differently
 *
 * Both are asked for a selection from the allowed aspects (see
 * `packages/core/src/reviews/prompt-builder.ts`). DeepSeek's fake answers in the exact requested form,
 * `ASPECTS: a, b`; MiniMax's fake wraps it in a sentence, which is what a real model that has not been
 * fine-tuned on your format does about a third of the time. Both must produce the same draft, and that
 * they do is the point: the selection is *recognised* out of the answer rather than parsed from it, so a
 * provider with different manners is not a provider with different behaviour.
 *
 * ## No credential is invented, and none could be
 *
 * The brief's rule 15 forbids inventing a value the real system will hold, and a plausible API key is
 * the worst case of it — a leak scanner cannot tell a plausible key from a real one, and neither can a
 * person. So {@link validateLlmKey} checks only what is true of **every** vendor's key and needs no
 * guess about any one vendor's format: present, single-token, and long enough that nothing shorter is
 * issued by anybody. The authoritative check is the probe, which is asynchronous precisely because the
 * real adapter has to ask the provider — a well-formed key and a live key are different questions and
 * only the vendor can answer the second.
 *
 * The fake answers the second question from {@link REJECTED_KEY_MARKER}, the same device
 * `REFERENCE_MARKERS` uses in the card-gateway fake: a test needs a key the provider rejects, and a
 * marker suffix is a way to have one without a string that looks like a credential.
 */
import { AppError } from '@berelax/shared'
import type { CallLog } from '../call-log.ts'
import { type FailureScript, failureError } from '../failure.ts'
import {
  type LlmOutcome,
  type LlmPricing,
  type LlmProvider,
  type LlmRequest,
  type LlmUsage,
  validateLlmKey,
} from './port.ts'

export const DEEPSEEK = 'deepseek'
export const MINIMAX = 'minimax'

/**
 * A key ending in this is rejected by the provider's probe.
 *
 * Upper case and hyphenated so it cannot be mistaken for part of a real key, and so `pnpm secrets`
 * reads any fixture built from it as a placeholder rather than a credential.
 */
export const REJECTED_KEY_MARKER = '-REJECTED-BY-PROVIDER'

/**
 * Prices, in fils per million tokens. **Provisional** — `OPEN-QUESTIONS Y1-llm-pricing`.
 *
 * Deliberately NOT the numbers on either vendor's pricing page today: those change, they are quoted in
 * USD, and a figure copied here would be indistinguishable from a configured one the moment it went
 * stale (the brief's rule 15). What these numbers are for is making the per-run cap testable and the
 * two providers distinguishable — MiniMax is dearer here so that switching provider visibly changes the
 * recorded cost, which is what the settings criterion asks to be observable.
 *
 * The same shape as `PROVISIONAL_COST_PER_SEGMENT_FILS` in the SMSala fake, and it is replaced the same
 * way: by the rate on the signed contract, in one constant, before the first real call.
 */
export const PROVISIONAL_DEEPSEEK_PRICING: LlmPricing = Object.freeze({
  inputFilsPerMillionTokens: 500,
  outputFilsPerMillionTokens: 2_000,
})

export const PROVISIONAL_MINIMAX_PRICING: LlmPricing = Object.freeze({
  inputFilsPerMillionTokens: 800,
  outputFilsPerMillionTokens: 3_200,
})

/** FNV-1a, so a fake's choice of aspects is a stable function of the prompt and nothing else. */
function hash(text: string): number {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value
}

/**
 * The aspects a fake selects, read out of the prompt's own allowed list.
 *
 * Read from the prompt rather than hard-coded, so the fake cannot name an aspect the prompt did not
 * offer — which would make the fake a source of drift between the vocabulary and the tests that use it.
 * The choice is a hash of the prompt, so the same review always draws the same selection and the draft
 * is byte-identical across runs.
 */
function chooseAspects(prompt: string): readonly string[] {
  const line = prompt.split('\n').find((candidate) => candidate.startsWith('ALLOWED_ASPECTS: '))
  if (line === undefined) return []
  const allowed = line.slice('ALLOWED_ASPECTS: '.length).split(', ')
  if (allowed.length === 0) return []
  const seed = hash(prompt)
  const first = allowed[seed % allowed.length] as string
  const second = allowed[(seed >>> 8) % allowed.length] as string
  return first === second ? [first] : [first, second]
}

interface NamedFakeOptions {
  readonly log: CallLog
  readonly failures: FailureScript
}

interface NamedFakeShape {
  readonly name: string
  readonly pricing: LlmPricing
  /** How this provider phrases the selection. The difference a consumer must not care about. */
  readonly render: (aspects: readonly string[]) => string
}

function createNamedFake(shape: NamedFakeShape, options: NamedFakeOptions): LlmProvider {
  const { log, failures } = options
  const byIdempotencyKey = new Map<string, LlmOutcome>()
  let inputTokens = 0
  let outputTokens = 0

  /** Roughly four characters to a token. Close enough to make a budget guard testable. */
  const estimate = (text: string): number => Math.max(1, Math.ceil(text.length / 4))

  return {
    name: shape.name,
    pricing: shape.pricing,

    async validateKey(key: string): Promise<void> {
      validateLlmKey(shape.name, key)
      // The provider's own answer. A real adapter reaches the vendor here; the fake reaches its marker.
      // Either way this is the step that distinguishes a well-formed key from a live one, and it is why
      // the method is asynchronous.
      const armed = failures.take()
      if (armed !== undefined) {
        log.record({
          provider: shape.name,
          operation: 'validate_key',
          outcome: 'failure',
          summary: `Key validation could not complete: ${armed}`,
          detail: { failureMode: armed },
        })
        throw failureError(shape.name, armed)
      }
      if (key.endsWith(REJECTED_KEY_MARKER)) {
        log.record({
          provider: shape.name,
          operation: 'validate_key',
          outcome: 'failure',
          summary: `${shape.name} rejected the key`,
          // The key itself is never logged. An outbox a person can open is not a place for a
          // credential, valid or not.
          detail: { rejected: true },
        })
        throw new AppError(
          'validation',
          `${shape.name} rejected this API key. It is well formed but ${shape.name} does not ` +
            'recognise it — check it was copied from the right project and has not been revoked.',
          { details: { provider: shape.name } },
        )
      }
      log.record({
        provider: shape.name,
        operation: 'validate_key',
        outcome: 'success',
        summary: `${shape.name} accepted the key`,
        detail: { accepted: true },
      })
    },

    async complete(request: LlmRequest): Promise<LlmOutcome> {
      const armed = failures.take()
      if (armed !== undefined) {
        log.record({
          provider: shape.name,
          operation: 'complete',
          outcome: 'failure',
          summary: `Completion for ${request.purpose} failed: ${armed}`,
          detail: { failureMode: armed, purpose: request.purpose },
        })
        throw failureError(shape.name, armed)
      }

      const replayed = byIdempotencyKey.get(request.idempotencyKey)
      if (replayed !== undefined) {
        log.record({
          provider: shape.name,
          operation: 'complete',
          outcome: 'success',
          summary: 'Cached completion returned; the budget is not spent twice',
          detail: { idempotencyKey: request.idempotencyKey, kind: replayed.kind },
        })
        return replayed
      }

      const input = estimate(request.prompt)
      inputTokens += input
      const text = shape.render(chooseAspects(request.prompt))
      const output = Math.min(estimate(text), request.maxOutputTokens)
      outputTokens += output

      const completion: LlmOutcome = {
        kind: 'completion',
        text,
        usage: { inputTokens: input, outputTokens: output },
      }
      byIdempotencyKey.set(request.idempotencyKey, completion)
      log.record({
        provider: shape.name,
        operation: 'complete',
        outcome: 'success',
        summary: `Selected aspects for a ${request.purpose}, ${output} output token(s)`,
        detail: {
          purpose: request.purpose,
          locale: request.locale,
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

/** DeepSeek's fake: answers in exactly the requested form. */
export function createFakeDeepSeek(options: NamedFakeOptions): LlmProvider {
  return createNamedFake(
    {
      name: DEEPSEEK,
      pricing: PROVISIONAL_DEEPSEEK_PRICING,
      render: (aspects) =>
        aspects.length === 0 ? 'ASPECTS: none' : `ASPECTS: ${aspects.join(', ')}`,
    },
    options,
  )
}

/**
 * MiniMax's fake: wraps the selection in a sentence.
 *
 * Not a gratuitous difference. A model answering "Based on the review, the aspects are: x, y." is the
 * ordinary case, and a consumer that only worked against a provider answering in the exact requested
 * form would break on the switch this unit's criterion says must need no code change.
 */
export function createFakeMiniMax(options: NamedFakeOptions): LlmProvider {
  return createNamedFake(
    {
      name: MINIMAX,
      pricing: PROVISIONAL_MINIMAX_PRICING,
      render: (aspects) =>
        aspects.length === 0
          ? 'Based on the review, no listed aspect applies.'
          : `Based on the review, the aspects are: ${aspects.join(', ')}.`,
    },
    options,
  )
}
