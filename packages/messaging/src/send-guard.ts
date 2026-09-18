import type { AppEnv } from '@berelax/config'
import { isProduction } from '@berelax/config'
import type { OutboundMessage } from './port.ts'

/**
 * The staging send guard.
 *
 * Emailing or texting a real client from a staging run is the classic disaster of this kind of
 * project, and it is unrecoverable: you cannot un-send an SMS to someone else's client. So the rule
 * is structural rather than procedural — outside production, a message can only reach an explicitly
 * allowlisted recipient. Everything else is diverted to the local outbox, where it is still
 * inspectable.
 *
 * Note this is deliberately not a feature flag. There is no setting that switches it off, because
 * any setting that can be switched off eventually is.
 */
export type GuardDecision =
  | { readonly kind: 'deliver' }
  | { readonly kind: 'divert'; readonly reason: string }

export interface GuardContext {
  readonly appEnv: AppEnv
  readonly outboundAllowlist: readonly string[]
}

const normalise = (recipient: string): string => recipient.trim().toLowerCase()

export function guardOutbound(ctx: GuardContext, message: OutboundMessage): GuardDecision {
  if (isProduction(ctx.appEnv)) return { kind: 'deliver' }

  const recipient = normalise(message.recipient)
  const allowed = ctx.outboundAllowlist.some((entry) => normalise(entry) === recipient)

  if (allowed) return { kind: 'deliver' }

  return {
    kind: 'divert',
    reason:
      `APP_ENV=${ctx.appEnv} and ${message.recipient} is not in OUTBOUND_ALLOWLIST. ` +
      'Diverted to the local outbox. Only production delivers to arbitrary recipients.',
  }
}
