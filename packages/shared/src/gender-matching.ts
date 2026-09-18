import { z } from 'zod'

/**
 * Same-gender therapist matching: the two modes it has, and the normaliser that makes **strict** the
 * answer no argument is needed for.
 *
 * ## Why the vocabulary is here and not in the module that applies the rule
 *
 * Three packages that may not import one another read it. `@berelax/config` declares the setting and
 * validates what may be written into it; `@berelax/db` reads the stored value and mirrors the rule in
 * SQL; `@berelax/core` holds the rule. `packages/db` must never import `packages/core` — the
 * dependency runs the other way — so a union spelled in core would be re-spelled in db and a third
 * time in the registry's `z.enum`, and the day the set changes, two of the three learn about it and
 * one does not. `TherapistSkill` is in this package for exactly that reason, and this is the same
 * boundary.
 *
 * ## Two modes, because a third is not a decision anybody took
 *
 * ADR 0020 and docs/01 decision 19 both say the same thing: *a hard constraint in the availability
 * solver, default strict, downgradable to advisory only as an audited configuration change and only
 * once the licensing authority confirms in writing*. Neither names a third state, and docs/04 §3 is
 * **[UNVERIFIED]** about the rule itself (Y9-gender) rather than about how far it may be relaxed.
 *
 * `'off'` was nevertheless accepted by the registry's schema until B-AVAIL-05 and is not any more.
 * "Relaxed to a warning" and "not applied at all" are different decisions, and only the first was
 * taken; a value the database could hold and no document justifies is a compliance position nobody
 * signed. A row still carrying `'off'` — written before the schema narrowed — reads as `'strict'`
 * through {@link genderMatchingMode} rather than as "no constraint", which is the only safe direction
 * for a stored value that has stopped being a legal one.
 *
 * ## Strict is the value that needs no argument
 *
 * {@link genderMatchingMode} is total over `unknown` and returns `'strict'` for everything that is not
 * exactly the string `'advisory'`: a missing row, `null`, `undefined`, `'off'`, `'Advisory'`, a
 * number, an object left behind by a half-finished migration. The permissive shape of this function —
 * parse, and on failure return what the caller passed, or throw and let a caller decide — is what
 * turns an unreadable setting into a permissive system, and it fails in the one direction that
 * matters: a slot offered to a client no therapist on the floor may legally treat.
 */
export const GENDER_MATCHING_MODES = ['strict', 'advisory'] as const
export type GenderMatchingMode = (typeof GENDER_MATCHING_MODES)[number]

/**
 * The mode in force when nobody has said otherwise.
 *
 * Exported so that no call site writes the literal `'strict'` as a fall-back of its own. A fall-back
 * spelled at the call site is a second default, and the second one is the one that is forgotten when
 * the first is corrected.
 */
export const STRICT_GENDER_MATCHING: GenderMatchingMode = 'strict'

/** The registry key the mode is stored under. One spelling for the registry, the reader and the tests. */
export const GENDER_MATCHING_SETTING_KEY = 'booking.same_gender_matching'

/** What may be WRITTEN. Narrower than what may be read, which is `unknown` — see the header. */
export const genderMatchingModeSchema = z.enum(GENDER_MATCHING_MODES)

/**
 * The stored value, as a mode. Total, and biased to strict by construction.
 *
 * `=== 'advisory'` rather than a membership test against {@link GENDER_MATCHING_MODES}: the one
 * relaxed mode has to be asked for exactly. The two behave identically today, and they stop behaving
 * identically the moment a third label is added — a membership test would admit it on the strength of
 * being in the list, where this refuses anything this build has not been taught to relax for.
 */
export function genderMatchingMode(value: unknown): GenderMatchingMode {
  return value === 'advisory' ? 'advisory' : STRICT_GENDER_MATCHING
}
