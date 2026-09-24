import { loadSuppressionPeppers, type SuppressionPeppers } from '@berelax/db'

/**
 * The pepper the fixture suppression list is keyed under (C-CRM-04).
 *
 * `suppression.key_hmac` is an HMAC under `SUPPRESSION_PEPPER`, and a fresh worktree has no secret store.
 * The three ways out of that are all worse than this one:
 *
 *   - **seeding no suppressions when the pepper is absent** leaves the acceptance criterion — a content
 *     scan over a *seeded* suppression table — with nothing to scan in a default `pnpm seed`, which is a
 *     gate that passes because it examined nothing (ADR 0003);
 *   - **requiring the secret before `pnpm seed` will run** breaks the one command a new checkout is told
 *     to run, and `pnpm verify` with it;
 *   - **generating a random pepper per run** produces rows nothing can match on the next run, which is a
 *     suppression list that silently forgets.
 *
 * So the fixture has a pepper of its own, and the whole of the argument for it being safe is the VERSION
 * LABEL. `suppression.pepper_version` exists to say which pepper keyed a row, and every row keyed under
 * this one says `fixture` in that column — so a fixture row is distinguishable from a production row by a
 * column that is already there for exactly this purpose, and the secret itself says what it is in its own
 * text. Nothing in a shipped runtime path reads it: the application reads
 * `loadSuppressionPeppers(loadConfig())`, which refuses loudly and by name when the environment has none,
 * and this module is in `packages/fixtures`, which no runtime imports.
 *
 * It is deliberately NOT a plausible-looking random string (brief rule 15): a 44-character base64 blob
 * here would be indistinguishable from a configured secret to anybody who found it in a `.env`, and the
 * point of a fixture value is that it is visibly one.
 */
export const FIXTURE_SUPPRESSION_PEPPER =
  'FIXTURE-PEPPER-not-a-secret-do-not-use-in-production-C-CRM-04'

/** The label every fixture-keyed row carries in `suppression.pepper_version`. */
export const FIXTURE_SUPPRESSION_PEPPER_VERSION = 'fixture'

/**
 * The peppers to key fixture rows under: the configured pair when there is one, the fixture otherwise.
 *
 * The configured pair wins, so a developer who has set `SUPPRESSION_PEPPER` gets a fixture keyed the way
 * their application will read it — a seed that ignored the environment would produce a list that the
 * running application could not match, and the symptom of that is a promotional message sent to a
 * fixture contact who is on the list.
 *
 * Resolved through `loadSuppressionPeppers` in both branches rather than by constructing the pair here,
 * so the length floor, the whole-or-absent rule for the retired slot and the distinct-label rule are the
 * same ones the application is held to. A fixture that built its pair by hand could hold a shape the
 * repository refuses.
 */
export function fixtureSuppressionPeppers(
  env: Readonly<Record<string, string | undefined>>,
): SuppressionPeppers {
  const configured = env['SUPPRESSION_PEPPER']
  if (configured !== undefined && configured.trim() !== '') {
    return loadSuppressionPeppers({
      SUPPRESSION_PEPPER: configured,
      SUPPRESSION_PEPPER_VERSION: env['SUPPRESSION_PEPPER_VERSION'],
      SUPPRESSION_PEPPER_PREVIOUS: env['SUPPRESSION_PEPPER_PREVIOUS'],
      SUPPRESSION_PEPPER_PREVIOUS_VERSION: env['SUPPRESSION_PEPPER_PREVIOUS_VERSION'],
    })
  }
  return loadSuppressionPeppers({
    SUPPRESSION_PEPPER: FIXTURE_SUPPRESSION_PEPPER,
    SUPPRESSION_PEPPER_VERSION: FIXTURE_SUPPRESSION_PEPPER_VERSION,
  })
}
