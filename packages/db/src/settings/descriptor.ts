import {
  STATEMENT_DESCRIPTOR_LIMIT_SETTING_KEY,
  STATEMENT_DESCRIPTOR_OPEN_QUESTION_ID,
  STATEMENT_DESCRIPTOR_SETTING_KEY,
  STATEMENT_DESCRIPTOR_SETTING_KEYS,
} from '@berelax/config'
import type { Sql } from '../connection.ts'
import { readSetting } from '../settings-store.ts'

/**
 * The statement descriptor and the MCC, as they are STORED (Y-PAY-10).
 *
 * Reading them is all this file does, and it returns both descriptor values as `unknown` on purpose.
 * JUDGING a descriptor is `lintStatementDescriptor` in `@berelax/core`, which `packages/db` may not
 * import, and a second judgement here would be a second answer to "may this descriptor be sent" the
 * first time a stored row went wrong. That is `readDepositPolicy`'s arrangement one module along, and
 * its note gives the sharper half of the reason: `Number(null)` is 0, and for the LIMIT 0 is not a legal
 * value but a coercing reader would turn "the row is corrupt" and "nobody has set one" into the same
 * fact.
 *
 * `readSetting` is the one read path for a setting — it checks the key against the F09 registry and
 * throws on an undeclared one, and it falls back to the registry's declared default, which for both of
 * these is `null`. So a freshly migrated database and a seeded one both answer "unset", which is the
 * truth.
 *
 * The keys are spelled in `packages/config` and nowhere else: a mismatched spelling is a reader that
 * silently falls back to the declared default, and for the limit the mistake would be invisible.
 */

export {
  STATEMENT_DESCRIPTOR_LIMIT_SETTING_KEY,
  STATEMENT_DESCRIPTOR_OPEN_QUESTION_ID,
  STATEMENT_DESCRIPTOR_SETTING_KEY,
  STATEMENT_DESCRIPTOR_SETTING_KEYS,
}

/** Both stored values, unnormalised. Handed to `lintStatementDescriptor` in `@berelax/core`. */
export interface StoredStatementDescriptor {
  readonly descriptor: unknown
  readonly limit: unknown
}

/**
 * The stored descriptor and its limit, as two raw values.
 *
 * One function for both keys rather than two readers, because every caller wants both: a descriptor is
 * judged against a limit, and a caller that read only the string would be asking whether a value fits
 * a length it does not have.
 */
export async function readStatementDescriptor(sql: Sql): Promise<StoredStatementDescriptor> {
  return {
    descriptor: await readSetting<unknown>(sql, STATEMENT_DESCRIPTOR_SETTING_KEY),
    limit: await readSetting<unknown>(sql, STATEMENT_DESCRIPTOR_LIMIT_SETTING_KEY),
  }
}

/** The MCC confirmation as the singleton legal entity holds it. Three facts or none, by constraint. */
export interface StoredMccConfirmation {
  readonly mcc: string | null
  readonly confirmedAtIso: string | null
  readonly confirmedBy: string | null
}

/**
 * The MCC confirmation, or three nulls.
 *
 * Read as THREE columns rather than as a boolean, because the three are what a refusal has to be able to
 * name: `mayUseRealPaymentProvider` in `@berelax/core` returns `mcc-not-confirmed`,
 * `mcc-not-recorded` and `mcc-confirmation-has-no-recorder` separately, and an operator fixing a go-live
 * needs to know which of the three is missing rather than that something is.
 *
 * No row at all answers three nulls rather than throwing. `legal_entity` is a singleton the migrations
 * seed, so an absent row is a database nobody has migrated — and the right answer to "may a real
 * provider be used" on such a database is no.
 */
export async function readMccConfirmation(sql: Sql): Promise<StoredMccConfirmation> {
  const [row] = await sql<StoredMccConfirmation[]>`
    select mcc,
           to_char(mcc_confirmed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
             as "confirmedAtIso",
           mcc_confirmed_by as "confirmedBy"
      from legal_entity
     order by id
     limit 1
  `
  return row ?? { mcc: null, confirmedAtIso: null, confirmedBy: null }
}
