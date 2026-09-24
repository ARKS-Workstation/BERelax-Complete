/**
 * Consent's pure half (C-CRM-03) and suppression's (C-CRM-04).
 *
 * `resolve.ts` is the point-in-time fold over the append-only consent log, and it fails closed to
 * `unknown`; `send-permission.ts` is the bridge from that fold to the promotional gate's synchronous
 * `hasConsent` evaluator, and it keeps "nobody opted in" and "nothing answered" apart.
 *
 * `sendability.ts` is the same pair of shapes for the suppression list — the fold, the gate evaluator,
 * and the precedence rule that a suppression beats consent with no exceptions — and `optout-token.ts` is
 * what a presented opt-out token grants. Neither mints anything and neither hashes anything: the HMAC
 * needs a pepper and a token needs a CSPRNG, and this package reads no environment and no ambient source
 * of randomness. Both of those live in `packages/db/src/repositories/suppression.ts`, beside the rows.
 */
export * from './optout-token.ts'
export * from './resolve.ts'
export * from './send-permission.ts'
export * from './sendability.ts'
