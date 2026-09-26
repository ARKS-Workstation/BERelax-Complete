import {
  CONTRAINDICATION_FLAG_KEYS,
  type ContraindicationFlagSet,
  contraindicationFlagSetSchema,
} from '@berelax/shared'
import type { Sql } from '../connection.ts'

/**
 * The reader of the boolean-only crossing (C-CRM-09).
 *
 * This is the whole of what the booking layer may know about a clinical record, and the module is arranged
 * so that it could not be more. It selects from `public.customer_contraindication_flags`, which migration
 * 0084 rebuilt to expose a customer id and the eight booleans of `CONTRAINDICATION_FLAG_KEYS`. It holds no
 * key, needs no clinical privilege — 0009 revokes all of it from `berelax_app` — and imports nothing from
 * `@berelax/clinical`.
 *
 * ## Why the reader is HERE and not beside the writer
 *
 * The writer is `packages/clinical/src/flags-view.ts`, and putting the reader next to it would have made
 * every consumer of the crossing import `@berelax/clinical` — the package holding the envelope, the KEK
 * parser and the store. The dependency rule that keeps the review-reply generator away from clinical data
 * would then be the only thing between a prompt builder and a package the whole application depends on. So
 * the two sides of the crossing are in two packages that do not import each other, and the crossing itself
 * is a view.
 *
 * ## `null` is not "no contraindications"
 *
 * {@link readContraindicationFlags} returns `null` when this client has no flag row, and every caller has to
 * treat that differently from a set of eight falses. A client with an intake submission and no flag row is a
 * derivation that has not been run, and rendering it as "not flagged" would be this system asserting that
 * somebody's form said no to eight questions when nothing has read it. The view cannot help here — there is
 * no row to carry a marker on — so the rule is stated at the reader, where the `null` is, and
 * `resolveContraindicationFreshness` in `@berelax/core` names the same case `no_flags_derived`.
 *
 * ## Why the row is parsed rather than cast
 *
 * `contraindicationFlagSetSchema` is `strictObject`, so a column added to the view without being added to
 * the closed set is a parse error rather than a property that travels. That is the one failure this reader
 * can actually catch: the view is the boundary, and the way a boundary leaks is a column somebody appended.
 */

/** The one place the crossing's column list is spelled for SQL. Adding a key is a migration, then this. */
const FLAG_COLUMNS = CONTRAINDICATION_FLAG_KEYS.join(', ')

/**
 * This client's contraindication flags, or `null` when nothing has been derived for them.
 *
 * `customer_id` is matched against the view's own column, which migration 0084 resolves through
 * `merge_survivor_of()`: a client whose duplicate record was merged away keeps their flags, and the two
 * histories are unioned, because either of them may hold the affirmative.
 */
export async function readContraindicationFlags(
  sql: Sql,
  customerId: string,
): Promise<ContraindicationFlagSet | null> {
  const rows = await sql.unsafe<Record<string, unknown>[]>(
    `select ${FLAG_COLUMNS} from public.customer_contraindication_flags where customer_id = $1::uuid`,
    [customerId],
  )
  const row = rows[0]
  if (row === undefined) return null
  // Parsed, not cast. See the module doc: a ninth column on the view is the shape of a leak, and
  // `strictObject` is what turns it into an error here instead of a value a caller renders.
  return Object.freeze(contraindicationFlagSetSchema.parse(row))
}

/**
 * The therapist ids assigned to any appointment of this client's, for the access decision.
 *
 * Ids and not a boolean, and not a decision: `resolveContraindicationAccess` in `@berelax/core` decides,
 * because `packages/db` may never import `packages/core` (brief rule 4) and because a boolean computed here
 * would be `rows.length > 0` — which is the query having returned every appointment rather than this
 * employee's, and reads identically at the call site.
 *
 * Every appointment, not only the forthcoming ones. A therapist who delivered a treatment yesterday still
 * has a reason to look at why they were told to ask about something, and a window on this query would be a
 * business rule about how long that lasts — which nobody has stated, so it is not invented here. What bounds
 * the read is that it is one client's flags and it is audited by the screen that performs it.
 */
export async function readAssignedTherapistIds(
  sql: Sql,
  customerId: string,
): Promise<readonly string[]> {
  const rows = await sql<{ therapistId: string }[]>`
    select distinct a.therapist_id as "therapistId"
      from appointment a
      join booking b on b.id = a.booking_id
     where b.customer_id = ${customerId}::uuid
  `
  return Object.freeze(rows.map((row) => row.therapistId))
}
