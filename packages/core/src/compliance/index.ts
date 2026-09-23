/**
 * Compliance: the public vocabulary (B-CAT-05, ADR 0020) and the calendar (M-VAT-10, docs/04 §9).
 *
 * The public display-name lint and the lexicon behind it. Pure: the licence-dependent half of the
 * rule — the claim terms and the permitted staff titles — is read from `regulatory_profile` by the
 * caller and passed in, because `packages/core` may not read a database and because the licence class
 * is still an open question (Y1-licence) whose answer must reach the lint as data.
 *
 * W-SITE-05 and W-SITE-10 reuse this for page copy; it is deliberately not scoped to the catalogue.
 *
 * `obligation.ts` is the other half of the same subject and the same shape: the rule is pure and the rows
 * are `@berelax/db`'s. It answers when a statutory obligation falls due, whether an overdue one is
 * blocking, and which behaviour a breach stops — a therapist leaving bookable availability, or publishing
 * refused with `PublishingBlocked`.
 *
 * `obligation-notice.ts` is M-VAT-11's continuation of it: who is told about a dated occurrence and when,
 * which role an unacknowledged one escalates to, what refuses a notice whose deadline has moved, and the
 * three states the open-compliance-questions dashboard separates — an unconfirmed duty, a confirmed duty
 * with no deadline on file, and an actual breach.
 */

export * from './lexicon.ts'
export * from './obligation.ts'
export * from './obligation-notice.ts'
