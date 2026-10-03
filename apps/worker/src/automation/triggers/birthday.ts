import { STOCK_JOURNEY_KEYS } from '@berelax/core'
import type { Sql } from '@berelax/db'
import { enrolAll, type TriggerOutcome } from './shared.ts'

/**
 * Whose birthday is today — a day and a month, and nothing else.
 *
 * C-AUTO-11. The acceptance line is two claims and this module is both of them:
 *
 *   - **Day and month only.** `customer` carries `birth_day` and `birth_month` and there is no
 *     birth-year column anywhere in this schema (migration 0155). This query asks for an equality on
 *     two `smallint`s; there is no age to derive and nowhere one could be derived from.
 *   - **It never reads the clinical schema.** That is asserted by counting the statements the pass
 *     issues rather than by reading the code, which is why {@link readBirthdayCandidates} is ONE query:
 *     a pass whose statement count is a property of its input cannot be held to a list of tables it
 *     touched.
 *
 * ## Why the hour is not in this file
 *
 * 10:00 Asia/Dubai is C-AUTO-11's provisional send hour and it is the SWEEP's schedule rather than this
 * module's: a trigger that knew what time it was would be a second reading of the promotional window,
 * which `promotional-window.ts` owns. This enrols; when the message leaves is the interpreter's and the
 * choke point's.
 */

/** One contact whose recorded birthday is the given day and month. */
export interface BirthdayCandidate {
  readonly customerId: string
}

/**
 * Every consented contact whose recorded birth day and month are the ones given, as ONE query.
 *
 * `month` and `day` are arguments and not `now()`: `packages/core` reads no clock and neither does this
 * pass — the sweep resolves today once, so every contact in one pass is judged against one date. A
 * query reading the server clock would judge the first and the last contact of a long pass against
 * different days at midnight.
 */
export async function readBirthdayCandidates(
  sql: Sql,
  args: { readonly month: number; readonly day: number },
): Promise<readonly BirthdayCandidate[]> {
  return sql<BirthdayCandidate[]>`
    select c.id as "customerId"
      from customer c
     where c.erased_at is null
       and c.birth_month = ${args.month}
       and c.birth_day = ${args.day}
       and (
         -- The LATEST record's kind, for the reason winback.ts states: a contact who granted and then
         -- withdrew has two rows and exists would pass them. A pre-filter, never the authority.
         select k.kind from consent k
          where k.contact_customer_id = c.id and k.channel = 'sms' and k.purpose = 'marketing'
          order by k.recorded_at desc, k.id desc
          limit 1
       ) = 'granted'
     order by c.id
  `
}

/** Enrol every contact whose birthday is today. */
export async function runBirthdayTrigger(
  sql: Sql,
  args: { readonly month: number; readonly day: number; readonly at: Date },
): Promise<TriggerOutcome> {
  const candidates = await readBirthdayCandidates(sql, args)
  return enrolAll(sql, {
    flowKey: STOCK_JOURNEY_KEYS.birthday,
    customerIds: candidates.map((candidate) => candidate.customerId),
    at: args.at,
  })
}
