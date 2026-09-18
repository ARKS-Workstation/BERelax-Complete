import {
  AppError,
  GENDER_MATCHING_SETTING_KEY,
  type GenderMatchingMode,
  genderMatchingMode,
} from '@berelax/shared'
import type { Sql } from '../connection.ts'
import { readSetting, type WriteResult, writeSetting } from '../settings-store.ts'
import type { UnitOfWork } from '../tx.ts'

/**
 * The availability settings the solver reads, and the one that is a compliance constraint.
 *
 * `booking.same_gender_matching` is `compliance_locked` in the registry: owner-only, audited, and a
 * change needs a written justification that `writeSetting` refuses to proceed without. It is also
 * `is_provisional` against `Y9-gender` — the rule is **in force** and the exact regulatory basis is
 * still unconfirmed, which is why the provisional value is the strict one (ADR 0020, docs/04 §3).
 *
 * ## The read path is fail-safe, and it does not rely on the row existing
 *
 * {@link readGenderMatching} answers `'strict'` for:
 *
 *   - a database with no `app_setting` row for the key — or with no row in the table at all, which is
 *     the state of every freshly migrated database, because 0010 creates the tables and seeds no values
 *     (`seedSettingDefaults` does that, from the registry, at boot);
 *   - a row holding a value that is no longer legal, including the `'off'` the registry's schema
 *     accepted until B-AVAIL-05;
 *   - a row holding anything else at all: `null`, a number, an object.
 *
 * Both halves point the same way on purpose. `readSetting` falls back to the registry's declared default
 * (`'strict'`), and {@link genderMatchingMode} then normalises whatever came out, so the permissive mode
 * is reachable only through a stored value that is exactly `'advisory'`. An `app_setting` row is not a
 * prerequisite for the constraint being enforced, which is the failure mode this unit is designed
 * against: a compliance rule that switches itself off when its configuration is missing.
 *
 * There is deliberately **no** `readGenderMatchingRaw`, and no variant that throws. A reader that throws
 * on a corrupted row leaves "what now" to whichever call site is first, and what ships is a `try/catch`
 * with a fall-back inside it — which is how the permissive answer gets written by hand.
 */

/** The registry key, re-exported so a caller does not have to know which package spells it. */
export { GENDER_MATCHING_SETTING_KEY } from '@berelax/shared'

/**
 * The mode in force. Strict unless a row says `'advisory'` in so many words.
 *
 * Reads through `readSetting`, so the key is checked against the registry and there is one read path for
 * every setting rather than a second query with its own opinion about defaults.
 */
export async function readGenderMatching(sql: Sql): Promise<GenderMatchingMode> {
  return genderMatchingMode(await readSetting(sql, GENDER_MATCHING_SETTING_KEY))
}

/**
 * Changes the mode. Owner-only, audited, and the reason is a required argument rather than an option.
 *
 * `writeSetting` already refuses a compliance-locked change with no justification and refuses any role
 * the registry does not list, so this wrapper adds exactly two things, both of which are about making
 * the refusal impossible to reach rather than repeating it:
 *
 *   - `reason` is a **required** parameter, so "no reason supplied" is a compile error at the call site
 *     instead of a runtime rejection behind whatever branch reached it;
 *   - it is refused when it is only whitespace. `writeSetting` tests the justification for truthiness,
 *     and `'   '` is truthy: a space bar is not the licensing authority's answer in writing.
 *
 * The value itself is validated by `writeSetting` against the registry's schema, which is where `'off'`
 * is now refused: a caller that still holds the old literal cannot re-introduce it, and the message it
 * gets names the setting in the words the admin panel shows.
 */
export async function setGenderMatching(
  uow: UnitOfWork,
  args: {
    readonly mode: GenderMatchingMode
    readonly role: string
    readonly actorLabel: string
    /** The authority's answer, in writing. Recorded in the audit row and in the setting's history. */
    readonly reason: string
  },
): Promise<WriteResult> {
  if (args.reason.trim().length === 0) {
    throw new AppError(
      'validation',
      'Same-gender therapist matching is compliance-locked: state the written basis for the change. ' +
        'Blank or whitespace is not a justification.',
      { userFacing: true, details: { key: GENDER_MATCHING_SETTING_KEY } },
    )
  }
  return writeSetting(uow, {
    key: GENDER_MATCHING_SETTING_KEY,
    value: args.mode,
    role: args.role,
    actorLabel: args.actorLabel,
    justification: args.reason,
  })
}
