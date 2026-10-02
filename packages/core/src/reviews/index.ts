/**
 * Review safety routing (G-REV-03) and the reply generator's pure half (G-REV-04).
 *
 * The docs/07 §4 table as a pure function returning a verdict plus the matched rule id, so an audit can
 * explain any decision; the escalation lexicon it judges text against, versioned so a historical verdict
 * can be reproduced; and the language identification that decides whether a reply can be written at all.
 *
 * Pure: the configured language set, the lexicon and the clock instant are arguments. The settings that
 * bear on an auto-send arrive raw and are normalised by `@berelax/shared`'s floors inside `routeReview`,
 * so no caller can relax one by pre-normalising it.
 *
 * G-REV-02 adds the fallback intake's pure half: the defensive parser for a forwarded Google
 * notification email, and the fixture bodies it is measured against. `email-parse.ts` takes the raw body
 * and the instant the forward arrived as arguments and returns either a parse or a paste request carrying
 * the bytes unmodified; the whole directory is under a scoped no-`Date`, no-`Intl` rule in
 * `scripts/check-core-purity.mjs`.
 *
 * G-REV-05 adds the send-path linter itself — `reply-linter.ts`, the rule set the delivery function runs in
 * both delivery modes — and `reply-linter.fixtures/`, one deliberately unpublishable reply per rule plus the
 * pairs that prove three of the rules are about what they claim. Pure in the same way: the regulatory
 * profile, the staff roster and the escalation lexicon are arguments, because the whole point of the roster
 * rule is that it reads a live row and `packages/core` reads no database.
 *
 * G-REV-04 adds the house-voice skeletons, the prompt builder that puts review text inside exactly one
 * delimited untrusted region, the screen that refuses a model response showing signs of having been
 * steered by it, and the reply-linter seam G-REV-05 will implement in full. All of it pure: the clock,
 * the lexicon, the language and the provider are arguments.
 */

export * from './count-phrase.ts'
export * from './email-parse.ts'
export * from './escalation-lexicon.ts'
export * from './escalation-reason.ts'
export * from './individuals.ts'
export * from './language.ts'
export * from './notification-fixtures.ts'
export * from './prompt-builder.ts'
export * from './red-team-corpus.ts'
export * from './reply-lint-contract.ts'
export * from './reply-linter.fixtures/index.ts'
export * from './reply-linter.ts'
export * from './routing.ts'
export * from './skeletons.ts'
