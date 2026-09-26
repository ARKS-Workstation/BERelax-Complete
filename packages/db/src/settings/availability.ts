import {
  AppError,
  FRONT_DESK_MIN_LEAD_SETTING_KEY,
  GENDER_MATCHING_SETTING_KEY,
  type GenderMatchingMode,
  genderMatchingMode,
  WHATSAPP_REF_EXPECTED_SETTING_KEY,
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

/** `booking.min_lead_minutes`. Provisionally 120 (Y9-lead). */
export const MIN_LEAD_SETTING_KEY = 'booking.min_lead_minutes'
/** `booking.max_advance_days`, counted in trading dates. Provisionally 90 (Y9-lead). */
export const MAX_ADVANCE_SETTING_KEY = 'booking.max_advance_days'

/** The two horizons the availability solver needs, as the settings registry declares them. */
export interface AvailabilityLimits {
  readonly minLeadMinutes: number
  readonly maxAdvanceDays: number
}

/**
 * The lead and advance horizons in force.
 *
 * A **separate** call from the availability query, deliberately, and B-AVAIL-07's own header says why: a
 * setting changes at human speed and is cached for minutes, where a slot list is cached for seconds — and
 * reading these two in the availability statement would mean spelling their provisional defaults in SQL,
 * which is a second source of truth for a figure nobody has confirmed. `readSetting` is the one read path
 * for a setting: it checks the key against the registry and falls back to the registry's declared default,
 * so a freshly migrated database with no `app_setting` rows behaves identically to a seeded one.
 *
 * Both values are coerced through `Number` and refused when they are not finite integers. The registry's
 * Zod schema validates a WRITE; this is a READ, and the value may have been written by an older build
 * whose schema was wider — the same reason `genderMatchingMode` normalises rather than trusts.
 */
export async function readAvailabilityLimits(sql: Sql): Promise<AvailabilityLimits> {
  const [lead, advance] = await Promise.all([
    readSetting<unknown>(sql, MIN_LEAD_SETTING_KEY),
    readSetting<unknown>(sql, MAX_ADVANCE_SETTING_KEY),
  ])
  return {
    minLeadMinutes: wholeMinutes(MIN_LEAD_SETTING_KEY, lead, 0),
    maxAdvanceDays: wholeMinutes(MAX_ADVANCE_SETTING_KEY, advance, 1),
  }
}

/**
 * A stored setting as a whole number at or above `floor`, or a refusal naming the key.
 *
 * Throwing rather than falling back, and that is the opposite of {@link readGenderMatching}'s choice for a
 * reason worth stating. A corrupted gender-matching value has a *stricter* reading to fall back to, so
 * falling back is safe; a corrupted lead time has no safe reading — a zero offers slots in the next minute
 * and a very large one offers none at all, and both look like working software.
 */
function wholeMinutes(key: string, value: unknown, floor: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(parsed) || parsed < floor) {
    throw new AppError(
      'invariant_violated',
      `Setting "${key}" holds ${JSON.stringify(value)}, which is not a whole number of at least ` +
        `${floor}. Availability cannot be computed from it, and there is no safe reading to fall back ` +
        'to: a zero offers slots in the next minute and a large one offers none at all.',
      { details: { key, value } },
    )
  }
  return parsed
}

/**
 * The notice the FRONT DESK needs, in minutes, as distinct from the online minimum.
 *
 * Its own setting rather than a reuse of `booking.min_lead_minutes` because Y9-lead's question is about
 * ONLINE booking in so many words, and B-UI-04's quick-book screen exists to seat a person standing at the
 * counter — a screen that applied a two-hour minimum could not book a walk-in. `FRONT_DESK_MIN_LEAD_SETTING_KEY`
 * carries the whole argument, including why zero is the SAFE direction and not merely the convenient one.
 *
 * Read through {@link readAvailabilityLimits}'s own coercion, so a stored value that is not a whole number
 * of minutes REFUSES rather than falling back — the reasoning `wholeMinutes` records: a corrupted lead time
 * has no safe reading, because a zero offers slots in the next minute and a large one offers none at all,
 * and both look like working software.
 */
export async function readFrontDeskMinLeadMinutes(sql: Sql): Promise<number> {
  return wholeMinutes(
    FRONT_DESK_MIN_LEAD_SETTING_KEY,
    await readSetting<unknown>(sql, FRONT_DESK_MIN_LEAD_SETTING_KEY),
    0,
  )
}

/**
 * Whether the front desk is expected to paste the WhatsApp ref code — Y12-ref-loop, as a value.
 *
 * Fail-safe in the direction that makes no claim about anybody. Anything that is not the boolean `true`
 * reads as `false`, including an absent row, a string `'true'` written by an older build and a null: the
 * permissive answer here is not a security relaxation but a claim about the FRONT DESK — a 0% capture rate
 * reported as a process failure when nobody ever told them to paste the code — and a claim about people is
 * the one thing an unreadable settings row must not be able to produce.
 *
 * `readGenderMatching`'s shape and not `readAvailabilityLimits`': there IS a safe reading to fall back to
 * here, which is why this one normalises rather than throws.
 */
export async function readWhatsappRefExpected(sql: Sql): Promise<boolean> {
  return (await readSetting<unknown>(sql, WHATSAPP_REF_EXPECTED_SETTING_KEY)) === true
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
