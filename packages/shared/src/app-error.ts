/**
 * The error taxonomy every module boundary in this build throws across.
 *
 * ## Why it is a leaf module and not part of the barrel any more
 *
 * It was declared in `index.ts` itself, which is fine until a module *inside* `shared` needs it: the
 * barrel re-exports every submodule, so a submodule importing `AppError` from `../index.ts` closes a
 * two-module cycle and `no-circular` in `.dependency-cruiser.cjs` refuses it — correctly, because build
 * order and reasoning about a cycle are undecidable. A-FIRST-02 hit it with `UnknownEventError` in
 * `analytics/taxonomy.ts`, which has to be a subclass: `isAppError` is `instanceof AppError`, so a
 * refusal raised as a plain `Error` reaches a visitor as a 500 rather than the 422 it is.
 *
 * The public API is unchanged — `index.ts` re-exports all three names — so every existing
 * `import { AppError } from '@berelax/shared'` still resolves to this class. Nothing imports this file
 * by path except the barrel and the submodules that must.
 */

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
