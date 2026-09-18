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
  readonly llm: LlmProvider
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
    calls: log,
    failures,
  }
}
