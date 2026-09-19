import { PROVIDER_TITLES } from '../compliance/lexicon.ts'
import { reviewTokens } from './escalation-lexicon.ts'

/**
 * Whether a piece of text identifies an individual.
 *
 * Extracted from `routing.ts` so there is **one** implementation of it. Two things ask the question, from
 * opposite directions, and they must agree:
 *
 *   - the routing table asks it of the **review** — a review that lets a reader identify who was on shift
 *     is never auto-answered (docs/07 §4 row 1);
 *   - the reply generator asks it of the **model's response** — a response that names a person is a
 *     response that has been steered by the review, and a public reply confirming who was on shift is a
 *     confidentiality breach in this industry (docs/07 §4, hard rules for the generator).
 *
 * A second copy of the heuristic would mean the day somebody widens the allow-list, one of the two learns
 * about it and the other does not — and the one that did not is whichever happens to be reading the
 * attacker's text.
 */

/**
 * Capitalised words that are not a person.
 *
 * Places, the business's own name, the platform, and the calendar. Deliberately short: a word missing
 * from it produces a false positive, and both callers are built so that a false positive is harmless — the
 * router's row can only fire on a review that already escalates for carrying free text, and the
 * generator's screen only ever refuses a draft in favour of a human writing one. Lengthening it can only
 * make the heuristic quieter, so it needs a reason each time.
 */
export const PROPER_NOUN_ALLOWLIST: ReadonlySet<string> = new Set([
  'abu',
  'dhabi',
  'uae',
  'emirates',
  'corniche',
  'google',
  'maps',
  'be',
  'relax',
  'berelax',
  'spa',
  'massage',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'ramadan',
  'eid',
])

/**
 * Two signals, both generous.
 *
 * A provider title from {@link PROVIDER_TITLES} — the same list the display-name lint refuses on a menu,
 * asked the opposite question — and a capitalised word that is not the first word of its sentence and is
 * not in {@link PROPER_NOUN_ALLOWLIST}.
 *
 * Sentence-initial capitals carry no information, so each sentence's first word is skipped. All-caps is
 * an acronym or emphasis ("GREAT"), not a name.
 */
export function textNamesAnIndividual(text: string | null | undefined): boolean {
  if (text === null || text === undefined) return false
  if (reviewTokens(text).some((token) => PROVIDER_TITLES.includes(token))) return true

  for (const sentence of text.split(/[.!?\n]+/)) {
    const words = sentence
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0)
    for (const word of words.slice(1)) {
      const bare = word.replace(/[^\p{L}]/gu, '')
      if (bare.length < 2) continue
      const first = bare.slice(0, 1)
      if (bare === bare.toUpperCase()) continue
      if (first !== first.toUpperCase()) continue
      if (PROPER_NOUN_ALLOWLIST.has(bare.toLowerCase())) continue
      return true
    }
  }
  return false
}
