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
     * The GA4 Measurement Protocol and Meta Conversions API adapters (A-MEAS-03).
     *
     * One key for both destinations rather than two, which is the opposite of the SMS/EMAIL split and
     * matches `GOOGLE_PROVIDER` covering four Google services: a deployment that has flipped analytics to
     * real has real analytics credentials, and a state in which one platform was fake and the other real
     * would be a state nothing in the health panel could describe. There is neither today — OPEN-QUESTIONS
     * `Y1-analytics-credentials` — so `real` resolves to `notImplemented` and `fake` is the only value
     * that does anything.
     *
     * In the refused-outside-production list below, for the reason SMS and EMAIL are: an advertising
     * account has no test recipient. A staging run's conversions land in the same property the owner
     * reads, inflate what a campaign is optimised on, and cannot be removed.
     */
    ANALYTICS_PROVIDER: providerMode.default('fake'),
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

    /**
     * The HMAC key behind every private-document link, and the label of the key each link was signed under.
     *
     * W-SYS-14. A signed URL is the only way a private document can be fetched, and it has to be verifiable
     * WITHOUT the provider: a presigned Spaces URL is checked by Spaces, so "this link expired" and
     * "somebody is guessing" would arrive as one third-party 403 — and there is no real Spaces adapter at
     * all (W-SYS-05's `[no-real-media-storage-adapter]`). So the signature is detached and this key is the
     * thing that verifies it. Holding it plus a document id is the ability to mint a link to that document;
     * it still authorises nothing without an authenticated session, because the signature authorises a
     * FETCH and never a principal.
     *
     * A fourth secret, and M-VAT-11's header argues against exactly that — "adding an eighth entry for a
     * link that lives fifteen minutes is a poor trade" — which is why ADR 0051 takes the other side
     * explicitly rather than quietly. The short form: the replay defence has to be a database row either
     * way, so a stored grant was buying revocability for a fifteen-minute link at the price of a WRITE on
     * the path that merely OFFERS a download.
     *
     * `…_PREVIOUS` is the retired key, consulted on VERIFICATION only and never used to sign. It is what
     * makes a rotation seamless for the links already in flight, and it is also what makes the refusals
     * mean anything: the version label is IN the signature and in the URL, so a link signed under a key
     * this deployment has rotated away from is `signature_unknown_key` — "signed by us, under a key we no
     * longer hold" — rather than indistinguishable from a forgery.
     *
     * Optional here for the reason the three KEKs and the pepper are: declaring the names is what this
     * schema is for, and the runtime reader (`documentSigningKeyRing` in `apps/web/src/media/storage.ts`)
     * refuses loudly and by name when it is absent — `[document-signing-not-configured]`, which serves no
     * document rather than serving one unsigned.
     */
    DOCUMENT_URL_SIGNING_SECRET: z.string().optional(),
    DOCUMENT_URL_SIGNING_SECRET_VERSION: z.string().optional(),
    DOCUMENT_URL_SIGNING_SECRET_PREVIOUS: z.string().optional(),
    DOCUMENT_URL_SIGNING_SECRET_PREVIOUS_VERSION: z.string().optional(),

    /**
     * Where the card gateway serves its hosted fields from — Y-PAY-03, SAQ-A.
     *
     * `frame` is the origin of the card-entry document the checkout puts in an iframe; `script` is the origin
     * of the gateway's hosted-fields script. Both are bare origins (`scheme://host[:port]`), and the CSP on
     * the checkout route names them and nothing else.
     *
     * **No default, and not derived from each other.** No gateway has been chosen and no merchant account
     * exists (OPEN-QUESTIONS `Y7-gateway`, `Y7-hosted-fields`), so there is no value to default to, and a
     * plausible-looking vendor domain is what brief rule 15 refuses: it is indistinguishable from a
     * configured one. Unset is a first-class state — `hostedFieldsFrom` in `@berelax/payments` returns
     * `not_configured` naming the missing keys, the checkout renders the refusal instead of a frame, and the
     * policy becomes `frame-src 'none'; script-src 'none'`. A checkout that cannot take a card is the
     * strictest safe option; one pointed at a guessed origin is not.
     *
     * NOT in the `real`-refused list above, because neither is a provider selection: a real origin outside
     * production reaches the gateway's public card-entry page and nothing else — no credential, no customer
     * and no token. What must not happen outside production is an authorisation, and `PAYMENT_PROVIDER=real`
     * is already refused for that (ADR 0005).
     */
    /**
     * The shared secret a card gateway signs its webhook deliveries with — Y-PAY-04.
     *
     * **No default, and `optional()` for the same reason the three KEKs and the document-signing secret
     * are.** No gateway has been chosen and no merchant account exists (OPEN-QUESTIONS `Y7-gateway`), so
     * there is no secret to default to — and the one default that would "work" is the one this schema
     * exists to make impossible: a webhook endpoint that trusts an unsigned body.
     *
     * Unset is a FIRST-CLASS state and it refuses: `webhookSigningSecretFrom` in `@berelax/payments`
     * answers `not_configured`, the endpoint answers **503** with `[payment-webhook-not-configured]`, and
     * no row is written. 503 and not 401, deliberately: 401 says *your signature is wrong* and the truth
     * is *we cannot check it*, which is a different fact with a different remedy — and a gateway retries a
     * 503 while a 401 makes it give up on an event that was perfectly valid.
     *
     * NOT in the `real`-refused list below: a signing secret is not a provider selection, and holding one
     * outside production lets a staging deployment verify a staging gateway's deliveries. What must not
     * happen outside production is an authorisation, and `PAYMENT_PROVIDER=real` is already refused for
     * that (ADR 0005).
     */
    PAYMENT_WEBHOOK_SIGNING_SECRET: z.string().optional(),

    PAYMENT_HOSTED_FIELDS_FRAME_ORIGIN: z.string().optional(),
    PAYMENT_HOSTED_FIELDS_SCRIPT_ORIGIN: z.string().optional(),

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
        /*
         * `LLM_PROVIDER` was MISSING from this list until G-SEO-05, although it has been in the schema
         * since the registry was built — so `LLM_PROVIDER=real` outside production parsed cleanly, and
         * `notImplemented('llm')` threw at boot instead of the configuration being refused by name.
         * That is the wrong failure in the right direction, which is why nobody found it: the system did
         * not start, and the message named a pending integration rather than a misconfiguration.
         *
         * It belongs here for ADR 0005's own reason rather than by symmetry. A real model outside
         * production spends real money on a real key with no cap this build can see, and the SEO agent's
         * prompts carry fetched competitor HTML and Search Console query strings — a staging run pointed
         * at a live provider sends somebody else's page content to a vendor under this business's
         * account. G-SEO-05's acceptance line is "a test asserts it cannot be selected unless
         * APP_ENV=production", and `env.test.ts` now asserts it alongside the other five.
         */
        ['LLM_PROVIDER', cfg.LLM_PROVIDER],
        ['ANALYTICS_PROVIDER', cfg.ANALYTICS_PROVIDER],
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
