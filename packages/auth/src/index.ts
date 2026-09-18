/**
 * @berelax/auth — password hashing, TOTP and session primitives.
 *
 * Separate from @berelax/core because it needs `node:crypto`, and core is pure. The authorisation
 * MATRIX lives in core (`@berelax/core/access`) precisely because deciding "may this role do this?"
 * requires no I/O and should be testable without one.
 */
export { assertPasswordPolicy, hashPassword, verifyPassword } from './password.ts'
export {
  assertAuthenticated,
  hashToken,
  type IssuedSession,
  issueSession,
  type LoginInput,
  type LoginStage,
  resolveLoginStage,
  SESSION_TTL,
} from './session.ts'
export {
  base32Decode,
  base32Encode,
  generateSecret,
  TOTP_PERIOD_SECONDS,
  totpAt,
  totpEnrolmentUri,
  verifyTotp,
} from './totp.ts'
