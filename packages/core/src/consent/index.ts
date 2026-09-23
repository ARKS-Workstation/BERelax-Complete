/**
 * Consent's pure half (C-CRM-03).
 *
 * `resolve.ts` is the point-in-time fold over the append-only record log, and it fails closed to
 * `unknown`; `send-permission.ts` is the bridge from that fold to the promotional gate's synchronous
 * `hasConsent` evaluator, and it keeps "nobody opted in" and "nothing answered" apart.
 *
 * The suppression list, the sendability precedence rule and the opt-out token are C-CRM-04's and will
 * sit beside these as `sendability.ts` and `optout-token.ts`.
 */
export * from './resolve.ts'
export * from './send-permission.ts'
