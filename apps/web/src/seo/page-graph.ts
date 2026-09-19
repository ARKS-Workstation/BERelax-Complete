/**
 * The graph for a rendered page, or `null`.
 *
 * The read is `readPageFacts` — the premises fact sheet and the licence class in force, on one connection —
 * and it is fail-soft for the reason that function records: a route whose database has not been seeded must
 * render the rest of itself rather than 500. A page with no structured data says nothing, which is the
 * honest state; a graph built from no row would say the business has no address.
 *
 * ## Why the licence class is read and not configured
 *
 * Because it is the row that decides whether the graph may claim a medical type at all (docs/09 §"Schema
 * types", ADR 0020), and a setting would be a second answer to a question `regulatory_profile` already
 * answers — versioned, superseded by replacement, with the strict default seeded by 0004. The acceptance
 * criterion asks that *"flipping the profile to a healthcare class is the only code path that can emit
 * them"*, and that is only true while the profile is what is read.
 */
import type { StructuredDataGraph } from '@berelax/core'
import { readPageFacts } from '../facts/page-facts.ts'
import { type PageGraphOptions, pageGraph } from './graph-input.ts'

/** Everything `pageGraph` needs except the two rows, which this function reads. */
export type PageGraphRequest = Omit<PageGraphOptions, 'facts' | 'licenceClass'>

/**
 * The graph for one route, read and built, or `null`.
 *
 * The build is deliberately **outside** the fail-soft read: a graph that cannot be assembled from a row that
 * was read is a defect in the builders, not a missing seed, and swallowing it would silently drop the block
 * from every page the day somebody broke a builder. The two failures look identical from outside the
 * function and they need opposite responses.
 */
export async function readGraphForPage(
  request: PageGraphRequest,
): Promise<StructuredDataGraph | null> {
  const source = await readPageFacts()
  if (source === null) return null
  return pageGraph({ ...request, facts: source.facts, licenceClass: source.licenceClass })
}
