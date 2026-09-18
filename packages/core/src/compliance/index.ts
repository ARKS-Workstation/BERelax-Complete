/**
 * Compliance vocabulary (B-CAT-05, ADR 0020).
 *
 * The public display-name lint and the lexicon behind it. Pure: the licence-dependent half of the
 * rule — the claim terms and the permitted staff titles — is read from `regulatory_profile` by the
 * caller and passed in, because `packages/core` may not read a database and because the licence class
 * is still an open question (Y1-licence) whose answer must reach the lint as data.
 *
 * W-SITE-05 and W-SITE-10 reuse this for page copy; it is deliberately not scoped to the catalogue.
 */

export * from './lexicon.ts'
