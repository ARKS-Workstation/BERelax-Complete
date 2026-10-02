import {
  DEPOSIT_ENABLED_SETTING_KEY,
  DEPOSIT_PERCENT_BP_SETTING_KEY,
  DEPOSIT_POLICY_SETTING_KEYS,
} from '@berelax/config'
import type { Sql } from '../connection.ts'
import { readSetting } from '../settings-store.ts'

/**
 * The deposit policy, as it is stored (Y-PAY-06).
 *
 * Two F09 settings, both declared `provisional: true` against **Y9-deposits**:
 * `payments.deposit_enabled` is `false` and `payments.deposit_percent_bp` is `0` — which is
 * `build/manifest.yaml`'s own provisional value for this unit, *"no services enrolled, 0% of gross"*.
 *
 * Reading them is all this file does, and it returns both as `unknown` on purpose. NORMALISING them is
 * `depositPolicy` in `@berelax/core`, which `packages/db` may not import, and a second normaliser here
 * would be a second answer to "may a deposit be taken" the first time a stored row went wrong. That is
 * `readCancellationWindow`'s arrangement one module along, and its note gives the sharper half of the
 * reason: `Number(null)` is 0, and 0 is a LEGAL percentage meaning "no deposit", so a reader that coerced
 * would make "the row is corrupt" and "the owner set zero" the same fact.
 *
 * `readSetting` is the one read path for a setting — it checks the key against the F09 registry and throws
 * on an undeclared one, and it falls back to the registry's declared default so a freshly migrated
 * database with no `app_setting` row behaves exactly like a seeded one.
 *
 * The keys are spelled in `packages/config` and nowhere else: this module imports them rather than
 * restating them, because a mismatched spelling is a reader that silently falls back to a declared
 * default — and for the percentage the fallback is a number, so the mistake would be invisible.
 */

/** `payments.deposit_enabled` and `payments.deposit_percent_bp`, re-exported so one import serves. */
export { DEPOSIT_ENABLED_SETTING_KEY, DEPOSIT_PERCENT_BP_SETTING_KEY, DEPOSIT_POLICY_SETTING_KEYS }

/** Both stored values, unnormalised. Handed to `depositPolicy` in `@berelax/core`. */
export interface StoredDepositPolicy {
  readonly enabled: unknown
  readonly percentBp: unknown
}

/**
 * The stored deposit policy, as two raw values.
 *
 * One function for both keys rather than two readers, because every caller wants both: a deposit is
 * either not taken at all or taken at a percentage, and a caller that read only the flag would ask for a
 * figure it had no rate for.
 */
export async function readDepositPolicy(sql: Sql): Promise<StoredDepositPolicy> {
  return {
    enabled: await readSetting<unknown>(sql, DEPOSIT_ENABLED_SETTING_KEY),
    percentBp: await readSetting<unknown>(sql, DEPOSIT_PERCENT_BP_SETTING_KEY),
  }
}
