import { AppError } from '@berelax/shared'
import { z } from 'zod'

/**
 * Configuration is validated once, at boot, and fails loudly.
 *
 * The alternative — reading `process.env.FOO` where it is needed — means a missing secret surfaces
 * as a runtime error on the one code path nobody exercised, typically at 01:00 while the salon is
 * still trading. Every key is declared here, every error is reported at once, and the process
 * refuses to start until they are all fixed.
 */

export const APP_ENVS = ['development', 'test', 'preview', 'staging', 'production'] as const
export type AppEnv = (typeof APP_ENVS)[number]

/** Non-production environments must never reach a real customer or a real provider. */
export const isProduction = (env: AppEnv): boolean => env === 'production'

const providerMode = z.enum(['fake', 'real'])

const schema = z
  .object({
    APP_ENV: z.enum(APP_ENVS),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    /** Business timezone. Asia/Dubai has no DST, but nothing may assume a fixed offset. */
    BUSINESS_TIMEZONE: z.string().default('Asia/Dubai'),

    /** Provider modes. Defaults are deliberately the safe ones. */
    SMS_PROVIDER: providerMode.default('fake'),
    EMAIL_PROVIDER: providerMode.default('fake'),
    GOOGLE_PROVIDER: providerMode.default('fake'),
    PAYMENT_PROVIDER: providerMode.default('fake'),
    LLM_PROVIDER: providerMode.default('fake'),
    /**
     * Where media derivatives are written.
     *
     * In the refused-outside-production list below, and the reason is the private bucket rather than
     * the public one: it holds the nineteen staff portraits at full resolution, and their photography
     * consent is not yet on record (`Y12-consent-photo`). A test run that wrote real originals of real
     * employees into the real bucket would be a data incident nothing would report.
     */
    MEDIA_STORAGE: providerMode.default('fake'),

    /**
     * Recipients a non-production environment is permitted to reach, so a developer can test
     * against their own handset. Everything else is diverted to the local outbox.
     */
    OUTBOUND_ALLOWLIST: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
      ),

    GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
    GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),

    /**
     * The key-encrypting keys, and the retired slot each rotation needs.
     *
     * **Three, since P-HR-01.** `STAFF_PII_KEK` seals the staff bank accounts and identity-document
     * numbers of migration 0050, and it is a third key for the same reason there are two: an
     * employment record does not relocate with the clinical store, so sealing it under `CLINICAL_KEK`
     * would either strand `employee_bank_detail` at relocation or put the clinical key in two places.
     * A rotation of either key must also not force a re-wrap of the other's estate.
     *
     * G-CONN-04 deferred the naming to H-HARD-03's secret inventory, and the answer is **two keys,
     * not one**: the clinical store is designed to relocate to a UAE-hosted database
     * (OPEN-QUESTIONS `Y5-residency`, ADR 0010) and would take its key with it, while the Google
     * refresh-token key belongs to a boundary the chokepoint gate polices separately. One shared key
     * would also tie the two rotation schedules together — a Google client-secret incident would
     * force a rotation of every clinical record's data key, for no security gain.
     *
     * Every one is `optional()` here on purpose. Declaring the names is what this schema is for
     * ("every key is declared here"); deciding whether production may boot without them is a
     * deployment question, and the two runtime readers — the Google consent callback and
     * `scripts/rotate-kek.mjs` — each refuse loudly and by name when their key is absent, which is
     * the behaviour that matters and is already tested.
     *
     * `…_PREVIOUS` is the retired key, RETAINED so rows that have not been re-wrapped yet can still
     * be decrypted. Discarding it before a rotation finishes is what makes records unreadable, so it
     * is a named slot rather than an ad-hoc export during the rotation.
     * `build/secret-inventory.json` and `docs/runbooks/key-rotation.md` hold the procedure.
     */
    CLINICAL_KEK: z.string().optional(),
    CLINICAL_KEK_VERSION: z.string().optional(),
    CLINICAL_KEK_PREVIOUS: z.string().optional(),
    CLINICAL_KEK_PREVIOUS_VERSION: z.string().optional(),
    GOOGLE_TOKEN_KEK: z.string().optional(),
    GOOGLE_TOKEN_KEK_VERSION: z.string().optional(),
    GOOGLE_TOKEN_KEK_PREVIOUS: z.string().optional(),
    GOOGLE_TOKEN_KEK_PREVIOUS_VERSION: z.string().optional(),
    STAFF_PII_KEK: z.string().optional(),
    STAFF_PII_KEK_VERSION: z.string().optional(),
    STAFF_PII_KEK_PREVIOUS: z.string().optional(),
    STAFF_PII_KEK_PREVIOUS_VERSION: z.string().optional(),

    /**
     * The suppression list's pepper, and the label of the pepper each row was keyed under.
     *
     * NOT a key-encrypting key and not a signing key: it is an HMAC key whose only job is to make
     * `suppression.key_hmac` irreversible. C-CRM-04 adds it because a plain digest would not be — the UAE
     * mobile space is about ten million numbers per prefix and a laptop enumerates it in seconds, so an
     * unpeppered SHA-256 of a phone number is a phone number with extra steps, and the whole claim of that
     * table is that a database dump does not disclose who has opted out.
     *
     * It is the one secret this unit could not avoid, and it is worth saying what was avoided instead: the
     * opt-out TOKEN is a STORED grant whose sha256 alone is kept, exactly as `obligation_evidence_grant`
     * is, rather than an HMAC over a URL — so there is one new entry in `build/secret-inventory.json` here
     * and not two.
     *
     * `…_PREVIOUS` is the retired pepper, RETAINED so rows keyed under it stay matchable while a rotation
     * is in progress. `suppression.pepper_version` holds the LABEL and never the pepper, the way
     * `google_connection.refresh_token_kid` does for a KEK. What a rotation cannot do is re-key a row
     * whose plaintext this system no longer holds — a hard bounce for an address with no customer record,
     * or a number imported from the national register — and `build/secret-inventory.json` states that
     * rather than implying the rotation is complete.
     *
     * Optional here for the reason the three KEKs are: declaring the names is what this schema is for, and
     * the runtime reader (`loadSuppressionPepper` in `@berelax/db`) refuses loudly and by name when it is
     * absent, which is the behaviour that matters and is tested.
     */
    SUPPRESSION_PEPPER: z.string().optional(),
    SUPPRESSION_PEPPER_VERSION: z.string().optional(),
    SUPPRESSION_PEPPER_PREVIOUS: z.string().optional(),
    SUPPRESSION_PEPPER_PREVIOUS_VERSION: z.string().optional(),

    SENTRY_DSN: z.string().optional(),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
  })
  .superRefine((cfg, ctx) => {
    // A real provider outside production is the single most dangerous misconfiguration in this
    // system: it can message real clients from a test run, and it burns real Google refresh
    // tokens against the ~100-per-account limit documented in docs/10 §4.
    const realProviders = (
      [
        ['SMS_PROVIDER', cfg.SMS_PROVIDER],
        ['EMAIL_PROVIDER', cfg.EMAIL_PROVIDER],
        ['GOOGLE_PROVIDER', cfg.GOOGLE_PROVIDER],
        ['PAYMENT_PROVIDER', cfg.PAYMENT_PROVIDER],
        ['MEDIA_STORAGE', cfg.MEDIA_STORAGE],
      ] as const
    ).filter(([, mode]) => mode === 'real')

    if (!isProduction(cfg.APP_ENV) && realProviders.length > 0) {
      for (const [key] of realProviders) {
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message:
            `${key}=real is refused when APP_ENV=${cfg.APP_ENV}. Only production may use real ` +
            'providers. This prevents messaging real clients from a test run and prevents ' +
            'consuming real Google refresh tokens outside production.',
        })
      }
    }

    if (cfg.GOOGLE_PROVIDER === 'real') {
      if (!cfg.GOOGLE_OAUTH_CLIENT_ID) {
        ctx.addIssue({
          code: 'custom',
          path: ['GOOGLE_OAUTH_CLIENT_ID'],
          message: 'GOOGLE_OAUTH_CLIENT_ID is required when GOOGLE_PROVIDER=real',
        })
      }
      if (!cfg.GOOGLE_OAUTH_CLIENT_SECRET) {
        ctx.addIssue({
          code: 'custom',
          path: ['GOOGLE_OAUTH_CLIENT_SECRET'],
          message: 'GOOGLE_OAUTH_CLIENT_SECRET is required when GOOGLE_PROVIDER=real',
        })
      }
    }

    if (isProduction(cfg.APP_ENV) && cfg.OUTBOUND_ALLOWLIST.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['OUTBOUND_ALLOWLIST'],
        message:
          'OUTBOUND_ALLOWLIST must be empty in production. It exists to let non-production ' +
          'environments reach a named test handset; in production it would silently restrict ' +
          'delivery to that list.',
      })
    }
  })

export type Config = Readonly<z.infer<typeof schema>>

/** Parse configuration from a plain record. Pure — the caller supplies the environment. */
export function parseConfig(source: Record<string, string | undefined>): Config {
  const result = schema.safeParse(source)
  if (!result.success) {
    const problems = result.error.issues.map(
      (i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`,
    )
    throw new AppError(
      'validation',
      `Invalid configuration — ${problems.length} problem(s):\n${problems.join('\n')}`,
      { details: { issues: result.error.issues } },
    )
  }
  return Object.freeze(result.data)
}
