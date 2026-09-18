import { AppError } from '@berelax/shared'

/** Exhaustiveness guard for discriminated unions — a missing case is a type error at build
 *  time and an invariant violation at runtime. */
export function assertNever(value: never, context: string): never {
  throw new AppError('invariant_violated', `Unhandled case in ${context}`, {
    details: { value: String(value) },
  })
}
