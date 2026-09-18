import { readPremisesFacts } from '@berelax/db'
import type { Facts } from '@berelax/shared'
import { siteOrigin } from '../routes/alternates.ts'
import { buildFacts } from './build.ts'
import { factsRuntime } from './runtime.ts'

/**
 * The facts, for a rendered page, or `null`.
 *
 * ## Why this swallows the failure and `/api/facts` does not
 *
 * Because the two answers differ in what a wrong answer costs. `/api/facts` is quoted by machines, so an
 * unreadable row has to be a 503 — a 200 with no address teaches a crawler that this business has no
 * address, and it will repeat that. A **page** has other content: a design-system gallery whose whole job
 * is the twelve-render sweep and the touch-target audit must not become a 500 because a worktree's database
 * has not been seeded, and three integration files that predate this unit drive that route.
 *
 * So the read is fail-soft, and the page renders a stated absence rather than nothing at all. That is the
 * same shape the therapist card already uses for a name nobody has set: the page shows what the site looks
 * like on day one instead of a happy path that hides the gap.
 *
 * The error is deliberately not logged here. The caller renders the absence, and a route handler that wants
 * the failure gets it loudly from `factsResponse`.
 */
export async function readFactsForPage(): Promise<Facts | null> {
  try {
    const runtime = factsRuntime()
    const read = await readPremisesFacts(runtime.sql)
    if (read === null) return null
    return buildFacts(read, { generatedAt: runtime.now(), origin: siteOrigin() })
  } catch {
    return null
  }
}
