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
