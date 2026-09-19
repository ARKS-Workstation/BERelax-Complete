/**
 * Review safety routing (G-REV-03).
 *
 * The docs/07 §4 table as a pure function returning a verdict plus the matched rule id, so an audit can
 * explain any decision; the escalation lexicon it judges text against, versioned so a historical verdict
 * can be reproduced; and the language identification that decides whether a reply can be written at all.
 *
 * Pure: the configured language set, the lexicon and the clock instant are arguments. The settings that
 * bear on an auto-send arrive raw and are normalised by `@berelax/shared`'s floors inside `routeReview`,
 * so no caller can relax one by pre-normalising it.
 */

export * from './escalation-lexicon.ts'
export * from './language.ts'
export * from './routing.ts'
