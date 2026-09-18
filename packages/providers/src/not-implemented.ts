/**
 * The real adapters, as far as they exist today.
 *
 * Each is a named module that the registry selects when its `*_PROVIDER` is `real`, and each throws
 * immediately, naming the unit that will build it and what it needs first.
 *
 * This shape is deliberate and is the point of docs/12 §1.3: **switching to a real provider is a
 * configuration change, and it already resolves to something.** A registry that only knew about
 * fakes would need editing to add a real adapter, which is the code change the contract exists to
 * avoid. A registry that resolved `real` to a fake would be worse still — the system would look
 * connected and send nothing.
 *
 * Throwing at construction rather than at first use is also deliberate. The failure belongs at boot,
 * where a deploy fails and someone is watching, not at 22:00 on the one code path that needed it.
 */
import { AppError } from '@berelax/shared'

export interface PendingIntegration {
  /** The manifest unit that builds it. */
  readonly unit: string
  /** What must exist before it can be built, from docs/05. */
  readonly needs: string
}

export const PENDING: Readonly<Record<string, PendingIntegration>> = {
  smsala: {
    unit: 'B-MSG',
    needs: 'two TDRA-registered sender IDs and the SMSala API credentials (docs/05)',
  },
  resend: { unit: 'B-MSG', needs: 'a verified sending domain with SPF, DKIM and DMARC (docs/05)' },
  'google-oauth': {
    unit: 'G-CONN',
    needs: 'an OAuth client and a published consent screen on the owner Google account (docs/10)',
  },
  'google-business-profile': {
    unit: 'G-REV',
    needs: 'Business Profile API access, which is granted by application review (docs/10 §2)',
  },
  'google-search-console': {
    unit: 'G-SEO',
    needs: 'a verified Search Console property for the production domain (docs/10)',
  },
  'card-gateway': {
    unit: 'Y-PAY',
    needs: 'a chosen gateway, a merchant account and an MCC (docs/05). Cards are explicitly later',
  },
  llm: { unit: 'G-SEO', needs: 'an API key and a monthly token budget the owner agrees to' },
}

/**
 * Builds the error a not-yet-built real adapter throws.
 *
 * `provider_unavailable` rather than `validation`: the configuration is legitimate, the integration
 * simply does not exist yet. An operator reading this needs to know which is which.
 */
export function notImplemented(provider: string): never {
  const pending = PENDING[provider]
  const detail =
    pending === undefined
      ? 'No real adapter has been built for it.'
      : `It is built by unit ${pending.unit} and needs ${pending.needs}.`
  throw new AppError(
    'provider_unavailable',
    `The real ${provider} adapter is not implemented. ${detail} ` +
      `Set the matching *_PROVIDER back to 'fake' to run against the local outbox.`,
    { details: { provider, ...pending } },
  )
}
