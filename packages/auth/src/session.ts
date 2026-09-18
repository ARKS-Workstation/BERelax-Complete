import { createHash, randomBytes } from 'node:crypto'
import type { Role } from '@berelax/core'
import { requiresTotp } from '@berelax/core'
import { AppError } from '@berelax/shared'

/**
 * Session tokens.
 *
 * The raw token is returned once, to be set as an httpOnly SameSite cookie. Only its SHA-256 hash is
 * ever stored, so a database leak does not hand over live sessions. 256 bits of entropy makes
 * guessing irrelevant.
 */
export interface IssuedSession {
  /** Returned to the client once. Never stored, never logged. */
  readonly token: string
  /** What goes in the database. */
  readonly tokenHash: string
  readonly expiresAtMs: number
}

const ACCESS_TTL_MS = 30 * 60 * 1000
const REFRESH_TTL_MS = 14 * 24 * 60 * 60 * 1000

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function issueSession(nowMs: number, kind: 'access' | 'refresh' = 'access'): IssuedSession {
  const token = randomBytes(32).toString('base64url')
  return {
    token,
    tokenHash: hashToken(token),
    expiresAtMs: nowMs + (kind === 'access' ? ACCESS_TTL_MS : REFRESH_TTL_MS),
  }
}

/**
 * The login state machine.
 *
 * `password_verified` is deliberately NOT an authenticated state for a role that requires a second
 * factor. Modelling it as a distinct stage is what makes "logged in without TOTP" unrepresentable
 * rather than merely discouraged.
 */
export type LoginStage =
  | { readonly stage: 'password_required' }
  | { readonly stage: 'totp_required'; readonly role: Role }
  | { readonly stage: 'totp_enrolment_required'; readonly role: Role }
  | { readonly stage: 'authenticated'; readonly role: Role }

export interface LoginInput {
  readonly role: Role
  readonly passwordVerified: boolean
  readonly totpEnrolled: boolean
  readonly totpVerified: boolean
}

export function resolveLoginStage(input: LoginInput): LoginStage {
  if (!input.passwordVerified) return { stage: 'password_required' }

  if (requiresTotp(input.role)) {
    if (!input.totpEnrolled) return { stage: 'totp_enrolment_required', role: input.role }
    if (!input.totpVerified) return { stage: 'totp_required', role: input.role }
  }

  // A role that does not require TOTP may still have enrolled; if it did, honour it.
  if (input.totpEnrolled && !input.totpVerified) return { stage: 'totp_required', role: input.role }

  return { stage: 'authenticated', role: input.role }
}

export function assertAuthenticated(stage: LoginStage): { readonly role: Role } {
  if (stage.stage !== 'authenticated') {
    throw new AppError('unauthenticated', `Login incomplete: ${stage.stage}`, {
      details: { stage: stage.stage },
    })
  }
  return { role: stage.role }
}

export const SESSION_TTL = { accessMs: ACCESS_TTL_MS, refreshMs: REFRESH_TTL_MS } as const
