import { listReviewIntakeTargets, type Sql } from '@berelax/db'

/**
 * Which Google listings this system manages, with the account each one is connected as (G-REV-06).
 *
 * ONE read, used by the approval queue, the detail screen and the paste form. It was the paste form's
 * private helper until this unit needed the same answer on two more screens, and it was moved here rather
 * than copied for the brief's reason — a second statement of a fact drifts, and the fact here is *which
 * listing a review may be filed against or replied to*. A screen working from a stale copy of that list
 * would offer the owner a reply box for a listing this system no longer serves.
 *
 * `listReviewIntakeTargets` in `@berelax/db` is the authority on the SET; the email is a join for the
 * screen, because docs/10 §2 says the account that owns the listing need not be the one verified on the
 * site and an operator choosing between two listings needs to see which account each is.
 */
export interface ReviewListing {
  readonly connectionId: string
  readonly placeId: string
  readonly googleEmail: string
}

export async function listReviewListings(sql: Sql): Promise<readonly ReviewListing[]> {
  const targets = await listReviewIntakeTargets(sql)
  if (targets.length === 0) return []
  const rows = await sql<{ id: string; google_email: string }[]>`
    select id::text as id, google_email from google_connections
    where id = any(${sql.array(targets.map((target) => target.connectionId))}::uuid[])
  `
  const emails = new Map(rows.map((row) => [row.id, row.google_email]))
  return targets.map((target) => ({
    connectionId: target.connectionId,
    placeId: target.placeId,
    // 'unknown account' and not a plausible address: an invented one is indistinguishable from a
    // configured one to the next reader (brief rule 15), and this is the string the paste form already
    // used for the same gap.
    googleEmail: emails.get(target.connectionId) ?? 'unknown account',
  }))
}
