import {
  PACKAGE_TRANSFERABLE_SETTING_KEY,
  PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY,
  PACKAGE_VALIDITY_MONTHS_SETTING_KEY,
  validateSetting,
} from '@berelax/config'
import type { Sql } from '../connection.ts'

/**
 * The three package-policy defaults, as they are STORED, with their provenance (M-TILL-09).
 *
 * The keys come from `@berelax/config` rather than being spelled again here, the obligation ladders'
 * reason one file along: a mismatched spelling is a reader that silently falls back to a declared default
 * and reports it as configured.
 *
 * ## Why this reads the provenance and not only the values
 *
 * These three settings are the DEFAULT a new `package_template_version` is created with, and they are all
 * provisional: Y9-package-policy is open, so nobody has said what the salon's package validity,
 * transferability or expiry treatment actually are. A version created from a still-unconfirmed default has
 * to carry that fact — `package_template_version.is_provisional` plus the question id — or the Unconfirmed
 * Assumptions panel would show the settings as unanswered while every template created from them looked
 * configured. So `isProvisional` here is read from `app_setting.is_provisional`, which `writeSetting`
 * CLEARS when a human confirms a value: once the owner has answered all three, new versions stop being
 * flagged, without anybody editing this file.
 *
 * ## Why `validateSetting` rather than a cast
 *
 * The registry's zod schema is the one normaliser, and it is exported. A cast here would be a second
 * opinion about what `app_setting.value` contains, and the value is `jsonb` — so a hand-edited row holding
 * `"6"` instead of `6` would reach a `smallint` column as a string and fail somewhere that names neither
 * the setting nor the edit.
 */
export {
  PACKAGE_POLICY_SETTING_KEYS,
  PACKAGE_TRANSFERABLE_SETTING_KEY,
  PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY,
  PACKAGE_VALIDITY_MONTHS_SETTING_KEY,
} from '@berelax/config'

/** The stored policy, and whether anybody has confirmed it. */
export interface PackageDefaultTerms {
  readonly validityMonths: number
  readonly transferable: boolean
  readonly unredeemedBalancePolicy: 'retained' | 'forfeited'
  /** True while ANY of the three is still flagged provisional in `app_setting`. */
  readonly isProvisional: boolean
  /** The open question the flagged ones name. `null` once none is flagged. */
  readonly openQuestionId: string | null
  readonly provisionalNote: string | null
}

interface StoredSetting {
  readonly key: string
  readonly value: unknown
  readonly isProvisional: boolean
  readonly openQuestionId: string | null
  readonly provisionalNote: string | null
}

export async function readPackageDefaultTerms(sql: Sql): Promise<PackageDefaultTerms> {
  const rows = await sql<StoredSetting[]>`
    select key, value, is_provisional as "isProvisional",
           open_question_id as "openQuestionId", provisional_note as "provisionalNote"
      from app_setting
     where key in (${PACKAGE_VALIDITY_MONTHS_SETTING_KEY}, ${PACKAGE_TRANSFERABLE_SETTING_KEY},
                   ${PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY})
     -- Ordered, so the note and the question id a flagged set reports are the SAME ones on every read.
     -- Without it the first flagged row is whichever one PostgreSQL happened to return first, and two
     -- reads of an unchanged database could describe the assumption differently. No backtick appears in
     -- this comment, deliberately: it lives inside a JS template literal and one would end it early.
     order by key
  `
  const byKey = new Map(rows.map((row) => [row.key, row]))
  // An unseeded key falls back to its declared default rather than to undefined, `readSetting`'s reason:
  // a fresh database has to behave identically to a seeded one. `validateSetting(key, undefined)` would
  // throw, so the fallback goes through the definition, which is what `validateSetting` validates against.
  const read = (key: string): unknown => byKey.get(key)?.value
  const flagged = rows.filter((row) => row.isProvisional)

  return {
    validityMonths: validateSetting(
      PACKAGE_VALIDITY_MONTHS_SETTING_KEY,
      read(PACKAGE_VALIDITY_MONTHS_SETTING_KEY) ?? 6,
    ) as number,
    transferable: validateSetting(
      PACKAGE_TRANSFERABLE_SETTING_KEY,
      read(PACKAGE_TRANSFERABLE_SETTING_KEY) ?? false,
    ) as boolean,
    unredeemedBalancePolicy: validateSetting(
      PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY,
      read(PACKAGE_UNREDEEMED_BALANCE_SETTING_KEY) ?? 'retained',
    ) as 'retained' | 'forfeited',
    isProvisional: flagged.length > 0,
    openQuestionId: flagged[0]?.openQuestionId ?? null,
    provisionalNote:
      flagged.length === 0
        ? null
        : `${flagged.length} of 3 package policy settings unconfirmed: ` +
          `${flagged.map((row) => row.key).join(', ')}`,
  }
}
