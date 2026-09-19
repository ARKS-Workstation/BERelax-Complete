/**
 * Provider selection, from configuration only.
 *
 * docs/12 §1.3: *a feature flag defaulting to the fake, flipped by config, never by a code change.*
 * This is that flag's implementation. Nothing in the codebase constructs a provider directly; every
 * consumer takes one from here, and which one arrives is decided by `SMS_PROVIDER`,
 * `EMAIL_PROVIDER`, `GOOGLE_PROVIDER`, `PAYMENT_PROVIDER` and `LLM_PROVIDER`.
 *
 * Two guarantees hold by construction rather than by care:
 *
 * **`real` outside production is impossible.** `parseConfig` refuses it before this code runs
 * ([ADR 0005](../../../docs/adr/0005-non-production-cannot-use-real-providers.md)), so a staging
 * environment cannot message a real customer however it is configured.
 *
 * **`real` today throws rather than silently degrading.** The real adapters exist as named modules
 * that refuse, naming the unit that will build them. A registry that quietly fell back to the fake
 * would give a production deploy that looks connected and sends nothing.
 *
 * Every provider shares one call log and one failure script, so the admin has a single inbox to show
 * and a test has a single place to arm a failure.
 */
import type { Config } from '@berelax/config'
import {
  AppError,
  LLM_PROVIDER_NAMES,
  type LlmProviderName,
  llmProviderName,
} from '@berelax/shared'
import { type CallLog, createCallLog } from './call-log.ts'
import { createFakeResend } from './email/fake-resend.ts'
import type { EmailProvider } from './email/port.ts'
import { FailureScript } from './failure.ts'
import {
  createFakeBusinessProfile,
  createFakeGoogleOAuth,
  createFakeSearchConsole,
} from './google/fake-google.ts'
import type {
  BusinessProfileProvider,
  GoogleOAuthProvider,
  SearchConsoleProvider,
} from './google/port.ts'
import { createFakeLlm } from './llm/fake-llm.ts'
import { createFakeDeepSeek, createFakeMiniMax } from './llm/named-fakes.ts'
import type { LlmProvider } from './llm/port.ts'
import { notImplemented } from './not-implemented.ts'
import { createFakeCardGateway } from './payments/fake-gateway.ts'
import { createManualPaymentProvider } from './payments/manual.ts'
import type { PaymentProvider } from './payments/port.ts'
import { createFakeSmsala } from './sms/fake-smsala.ts'
import type { SmsProvider } from './sms/port.ts'

export interface Providers {
  readonly sms: SmsProvider
  readonly email: EmailProvider
  readonly googleOAuth: GoogleOAuthProvider
  readonly businessProfile: BusinessProfileProvider
  readonly searchConsole: SearchConsoleProvider
  /** Cash and terminal. Always the real till adapter; there is no external service to fake. */
  readonly till: PaymentProvider
  /** Online cards. Absent until a gateway is chosen — see docs/01 decision on card payments. */
  readonly cards: PaymentProvider
  /** The default adapter, from `LLM_PROVIDER`. What a caller with no setting to consult uses. */
  readonly llm: LlmProvider
  /**
   * The adapter for a stored `agents.llm_provider` value.
   *
   * This is where "provider selectable in settings, no code change" actually lives: a consumer passes
   * the setting it read and gets an adapter. Switching from DeepSeek to MiniMax changes the row and
   * nothing else — no branch at any call site, because there is no call site that knows the names.
   *
   * It **throws** for a name this build has no adapter for, which is deliberately the opposite of the
   * auto-send floors in `@berelax/shared`. There, an unreadable setting resolves to the strictest
   * answer because the permissive one publishes a reply. Here the analogous fallback — quietly using
   * the local fake — would generate drafts with a provider the owner did not choose and bill an
   * account they did not agree, with nothing saying so. A throw reaches `withAgentRun`, which records
   * the run as failed and leaves `last_success_at` alone, so the watchdog reports the agent silent.
   */
  llmFor(setting: unknown): LlmProvider
  /** Every call any of them made, in order. The admin inbox and the tests read this. */
  readonly calls: CallLog
  /** Arm a failure on the next call, or on every call. Shared by all providers. */
  readonly failures: FailureScript
}

export interface ProviderRegistryOptions {
  readonly config: Config
  /** Injected, because nothing in this codebase reads the clock directly. */
  readonly now: () => string
  /** Supply a shared log when several registries must write to one inbox; otherwise one is made. */
  readonly log?: CallLog
  readonly failures?: FailureScript
}

export function createProviders(options: ProviderRegistryOptions): Providers {
  const { config, now } = options
  const log = options.log ?? createCallLog(now)
  const failures = options.failures ?? new FailureScript()
  const shared = { log, failures, now }

  return {
    sms: config.SMS_PROVIDER === 'real' ? notImplemented('smsala') : createFakeSmsala(shared),
    email: config.EMAIL_PROVIDER === 'real' ? notImplemented('resend') : createFakeResend(shared),
    googleOAuth:
      config.GOOGLE_PROVIDER === 'real'
        ? notImplemented('google-oauth')
        : createFakeGoogleOAuth(shared),
    businessProfile:
      config.GOOGLE_PROVIDER === 'real'
        ? notImplemented('google-business-profile')
        : createFakeBusinessProfile(shared),
    searchConsole:
      config.GOOGLE_PROVIDER === 'real'
        ? notImplemented('google-search-console')
        : createFakeSearchConsole(shared),
    // The till adapter is real in every environment: cash taken at the desk is recorded, not sent
    // anywhere, so there is nothing a fake would add and a fake would make the ledger fictional.
    till: createManualPaymentProvider({ log, now }),
    cards:
      config.PAYMENT_PROVIDER === 'real'
        ? notImplemented('card-gateway')
        : createFakeCardGateway(shared),
    llm: config.LLM_PROVIDER === 'real' ? notImplemented('llm') : createFakeLlm({ log, failures }),
    llmFor(setting: unknown): LlmProvider {
      const name = llmProviderName(setting)
      if (name === null) {
        throw new AppError(
          'validation',
          `agents.llm_provider holds ${JSON.stringify(setting)}, which is not one of ` +
            `${LLM_PROVIDER_NAMES.join(' | ')}. No draft is generated with a provider nobody chose.`,
          { details: { setting } },
        )
      }
      const adapter = ADAPTERS[name]
      if (adapter === null) {
        throw new AppError(
          'provider_unavailable',
          `agents.llm_provider is '${name}', for which no adapter has been built. The names that ` +
            `resolve today are ${BUILT_LLM_PROVIDERS.join(' | ')}.`,
          { details: { provider: name } },
        )
      }
      return adapter(shared)
    },
    calls: log,
    failures,
  }
}

/**
 * The adapter table. `null` is a declared name with nothing behind it.
 *
 * A table rather than a `switch`, and `Record<LlmProviderName, …>` rather than a partial map, so a name
 * added to `LLM_PROVIDER_NAMES` in `@berelax/shared` stops this file compiling until somebody decides
 * whether it has an adapter. A `switch` with a `default` would resolve it silently.
 */
const ADAPTERS: Readonly<
  Record<
    LlmProviderName,
    ((shared: { log: CallLog; failures: FailureScript }) => LlmProvider) | null
  >
> = Object.freeze({
  fake: (shared) => createFakeLlm(shared),
  deepseek: (shared) => createFakeDeepSeek(shared),
  minimax: (shared) => createFakeMiniMax(shared),
  // Declared in the setting because it is the obvious third candidate; no adapter yet. An owner who
  // picks it gets a sentence naming what does work, which is better than not offering it and being
  // told the system cannot.
  claude: null,
})

/** The names that resolve to an adapter today. For the message a refusal shows. */
export const BUILT_LLM_PROVIDERS: readonly LlmProviderName[] = Object.freeze(
  LLM_PROVIDER_NAMES.filter((name) => ADAPTERS[name] !== null),
)
