import { AppError } from '@berelax/shared'
import { type E164, normalisePhoneResult, type PhoneRejection } from './normalise-phone.ts'

/**
 * The throwing half of phone normalisation, split off so the rule itself has no runtime dependency.
 *
 * `normalise-phone.ts` is the rule: the digit folding, the trunk prefix, the landline refusal. Nothing in
 * it imports anything at run time, which is what lets the booking flow's client island import it through
 * `@berelax/core/phone` and normalise on blur through the SAME function the server uses — rather than a
 * browser-side copy of the folding, which would be the third reading of a UAE number in this repository
 * and the one that disagrees about `00971` on some Tuesday.
 *
 * `AppError` is the reason there is a second file at all. It lives in `@berelax/shared`'s barrel, which
 * re-exports three zod schema modules, so a module that touches it drags zod into whatever bundle imports
 * it: measured on this build the chunk holding the normaliser was 484KB before compression, over docs/08
 * SS8's entire first-party JS budget for a route.
 *
 * Both exports below are re-exported by `packages/core/src/identity/index.ts`, so `@berelax/core` offers
 * exactly what it did before and no caller of `normalisePhone` changed.
 */

/** Thrown by {@link normalisePhone}. Carries the reason as a value, not as prose. */
export class PhoneNormalisationError extends AppError {
  readonly reason: PhoneRejection

  constructor(reason: PhoneRejection, message: string, details: Record<string, unknown>) {
    super('validation', message, { userFacing: true, details: { ...details, reason } })
    this.name = 'PhoneNormalisationError'
    this.reason = reason
  }
}

/** As `normalisePhoneResult`, throwing a named error. Use where a bad number is a bug. */
export function normalisePhone(raw: string): E164 {
  const result = normalisePhoneResult(raw)
  if (result.ok) return result.e164
  throw new PhoneNormalisationError(
    result.reason,
    `"${raw}" is not a UAE mobile number this system can send an SMS to (${result.reason}). ` +
      'Identity is the phone number (ADR 0014), so an un-normalised number becomes a second ' +
      'customer record rather than an error anybody sees.',
    { raw },
  )
}
