import {
  type Actor,
  readSetting,
  type Sql,
  type WriteResult,
  withUnitOfWork,
  writeSetting,
} from '@berelax/db'
import type { LlmProvider } from '@berelax/providers/llm'
import {
  AppError,
  DEFAULT_LLM_PROVIDER,
  LLM_PROVIDER_SETTING_KEY,
  type LlmProviderName,
  llmProviderName,
} from '@berelax/shared'

/**
 * Choosing the LLM provider, and the key check that happens **before** the choice is stored.
 *
 * ## Why the validation is on the save path and not at first use
 *
 * An owner who pastes a wrong key and is told so immediately fixes it in ten seconds. An owner whose wrong
 * key is stored finds out when the review autoresponder has been silent for two days, and the only thing
 * that tells them is the watchdog — which reports the agent as silent, not the key as wrong. The two are
 * the same defect and they cost completely different amounts, and the difference is entirely whether the
 * key was checked before the row was written.
 *
 * So: resolve the adapter for the chosen name, ask *that adapter* to validate the key, and only then write
 * the setting. A key valid for DeepSeek is not valid for MiniMax, which is why the check is per-provider
 * and not a shape test in the settings registry — `packages/config` cannot make a network call, and a
 * validation that cannot reach the provider cannot answer the question that matters.
 *
 * ## Why this lives in packages/google
 *
 * Because it pairs `@berelax/db`'s `writeSetting` with `@berelax/providers`' adapter, and this is the
 * package that already depends on both — the same argument `review-routing.itest.ts` makes for itself.
 * `packages/db` may not import `packages/providers` (it would put a network client behind the write path),
 * and `packages/config` may not either. The LLM is not a Google service, and the review autoresponder that
 * consumes it is; if a second consumer appears, this moves.
 */

/** What the caller asked for, before anything is trusted about it. */
export interface LlmProviderChoice {
  /** The provider name, exactly as the admin form submitted it. */
  readonly provider: unknown
  /** The key to validate. Never stored by this function — see the note below. */
  readonly apiKey: string
  readonly role: string
  readonly actorLabel: string
}

/**
 * Validates the key against the chosen provider, then stores the choice.
 *
 * **The key is not stored here, deliberately.** `app_setting` is readable by the admin UI, its history is
 * append-only (ADR 0008), and a credential written into it could never be removed from
 * `app_setting_history`. The key belongs in the environment, where `parseConfig` reads it; what this
 * function persists is the *choice*, and what it guarantees is that the choice was made with a key the
 * provider accepted.
 *
 * Throws rather than returning a result for an invalid key: the caller is a form handler, and an
 * `AppError('validation')` is what the admin layer already turns into a message beside the field.
 */
export async function saveLlmProviderChoice(
  args: {
    readonly sql: Sql
    readonly actor: Actor
    /** Resolves a provider name to its adapter. `Providers.llmFor` from the registry. */
    readonly adapterFor: (name: string) => LlmProvider
  },
  choice: LlmProviderChoice,
): Promise<WriteResult> {
  const name = llmProviderName(choice.provider)
  if (name === null) {
    // Resolved here as well as by the registry, so the message names the setting rather than the
    // adapter table. The registry's refusal is about running; this one is about saving.
    throw new AppError(
      'validation',
      `"${String(choice.provider)}" is not an LLM provider this build knows. Nothing was saved.`,
      { userFacing: true, details: { key: LLM_PROVIDER_SETTING_KEY } },
    )
  }

  // Throws for an unbuilt adapter, and for a key the provider does not accept. Either way the setting is
  // untouched, which is the whole point of doing this first.
  await args.adapterFor(name).validateKey(choice.apiKey)

  return withUnitOfWork(args.sql, args.actor, (uow) =>
    writeSetting(uow, {
      key: LLM_PROVIDER_SETTING_KEY,
      value: name,
      role: choice.role,
      actorLabel: choice.actorLabel,
    }),
  )
}

/**
 * The stored provider name, or the default.
 *
 * The default rather than a throw, because a missing row is a database that has not been seeded and the
 * answer for it is the local fake — which reaches nothing and bills nobody. An unrecognised *value* is
 * different and is refused by `Providers.llmFor`: that is a row somebody wrote, and honouring it as the
 * fake would draft with a provider the owner did not choose.
 */
export async function readLlmProviderChoice(sql: Sql): Promise<LlmProviderName | unknown> {
  const stored = await readSetting(sql, LLM_PROVIDER_SETTING_KEY)
  return stored === undefined || stored === null ? DEFAULT_LLM_PROVIDER : stored
}
