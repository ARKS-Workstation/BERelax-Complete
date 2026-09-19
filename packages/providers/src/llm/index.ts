/**
 * The LLM port and its adapters, as a subpath export.
 *
 * A subpath rather than the package barrel, because `messaging-providers-only-inside-a-transport` in
 * `.dependency-cruiser.cjs` forbids the barrel outside a messaging transport — the barrel re-exports the
 * SMS and email ports, so importing it reaches SMSala while naming nothing forbidden. `packages/google`
 * already imports `@berelax/providers/google` for exactly that reason, and the review generator imports
 * this for the same one.
 */
export { createFakeLlm, FAKE_LLM, LOCAL_FAKE_PRICING } from './fake-llm.ts'
export {
  createFakeDeepSeek,
  createFakeMiniMax,
  DEEPSEEK,
  MINIMAX,
  PROVISIONAL_DEEPSEEK_PRICING,
  PROVISIONAL_MINIMAX_PRICING,
  REJECTED_KEY_MARKER,
} from './named-fakes.ts'
export {
  costOfFils,
  type LlmOutcome,
  type LlmPricing,
  type LlmProvider,
  type LlmPurpose,
  type LlmRequest,
  type LlmUsage,
  MINIMUM_LLM_KEY_LENGTH,
  validateLlmKey,
} from './port.ts'
