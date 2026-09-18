/**
 * @berelax/shared — the only package every other package may depend on.
 * Types, branded primitives and error taxonomy. No I/O, no framework imports.
 */

export type { Channel, MessageClass } from './messaging.ts'

/** Nominal typing helper, so an AppointmentId cannot be passed where a RoomId is wanted. */
export type Brand<T, B extends string> = T & { readonly __brand: B }

/** Every error crossing a module boundary is one of these. */
export type ErrorKind =
  | 'not_found'
  | 'conflict'
  | 'validation'
  | 'forbidden'
  | 'unauthenticated'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'invariant_violated'

export class AppError extends Error {
  readonly kind: ErrorKind
  /** Safe to show a customer. Anything else is internal-only. */
  readonly userFacing: boolean
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    kind: ErrorKind,
    message: string,
    options?: { userFacing?: boolean; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'AppError'
    this.kind = kind
    this.userFacing = options?.userFacing ?? false
    this.details = Object.freeze({ ...options?.details })
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError
