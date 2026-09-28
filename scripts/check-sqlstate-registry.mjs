#!/usr/bin/env node
/**
 * The private-SQLSTATE allocator: every refusal code is registered exactly once, and the entry is true.
 *
 * ## Why an allocator exists at all
 *
 * A private SQLSTATE is how a caller branches on the RULE rather than on a message, and every translator in
 * `packages/db` matches on the code ALONE. So a code standing for two rules reports one refusal as the
 * other, and a probe asserting it passes on a statement it never touched. Thirteen codes were shared when
 * W-SYS-12 started, and the cause was a convention with no allocator: a unit picked a CLASS by reading the
 * migrations it could see, and units in flight cannot see each other — four migrations claimed `ZY001` in
 * one afternoon. ADR 0043 replaced the convention with `packages/db/src/sqlstate-registry.ts` and this gate.
 *
 * ## What it measures, stated exactly
 *
 * It DERIVES the codes from the migration files. There is no list of known codes here, because a list of
 * codes beside the registry is the same defect one level up: two statements of one fact, and the one that
 * drifts is the one nobody reads. It reads `packages/db/migrations/*.sql`, blanks their comments, resolves
 * every raising function to the LAST migration that defines it, and compares the result with the registry
 * in five directions — see `registryProblems`. Each fails by its own rule name so a known-bad fixture can
 * assert which one it broke (ADR 0003); `scripts/test-gates.mjs` block 121 holds one fixture per direction.
 *
 * It does NOT check that a translator translates correctly, or that a rule sentence describes the refusal.
 * The first is `packages/fixtures/src/sqlstate-allocation.itest.ts`'s, which drives each moved refusal
 * end to end against a real PostgreSQL and asserts the code AND that rule's own message; the second is the
 * one thing here that is prose, and the registry says so on the field.
 *
 * It is a script rather than another vitest file for the reason the acceptance asks for: a registered
 * `pnpm verify` step named in gate case 29's array fails the build when it is dropped, where a convention
 * returns quietly. The same derivation is also asserted from `sqlstate-uniqueness.test.ts`, which imports
 * the same functions rather than restating them.
 *
 * usage: pnpm sqlstate
 */
import {
  liveRaisesByCode,
  PRIVATE_SQLSTATES,
  readMigrationCorpus,
  readTranslatorCorpus,
  registryProblems,
  translatorsByCode,
} from '../packages/db/src/sqlstate-registry.ts'

/**
 * Floors, not exact counts (ADR 0002).
 *
 * A glob that stops matching, a regex that stops matching or a corpus reader that returns an empty map all
 * produce a clean run over nothing, and "no problems" over an empty set is the failure this whole suite
 * exists to catch. Set well under the figures measured when this was written (86 migrations, 138 codes, 138 entries) and far
 * above zero, so the check fails rather than congratulating itself.
 */
const FLOORS = { migrations: 60, codes: 80, entries: 80 }

const corpus = readMigrationCorpus()
const raises = liveRaisesByCode(corpus)
const translators = translatorsByCode(readTranslatorCorpus())

const floorProblems = []
if (corpus.size < FLOORS.migrations) {
  floorProblems.push(
    `only ${corpus.size} migration(s) were read, under the floor of ${FLOORS.migrations}. The corpus is ` +
      'wrong, so every other answer below is an answer about nothing.',
  )
}
if (raises.size < FLOORS.codes) {
  floorProblems.push(
    `only ${raises.size} private SQLSTATE(s) were found in the migrations, under the floor of ` +
      `${FLOORS.codes}. The raise pattern has almost certainly stopped matching.`,
  )
}
if (PRIVATE_SQLSTATES.length < FLOORS.entries) {
  floorProblems.push(
    `the registry holds only ${PRIVATE_SQLSTATES.length} entr(ies), under the floor of ${FLOORS.entries}.`,
  )
}
if (floorProblems.length > 0) {
  console.error('The SQLSTATE scan examined too little to mean anything:\n')
  for (const problem of floorProblems) console.error(`  ${problem}`)
  process.exit(1)
}

const problems = registryProblems({ registry: PRIVATE_SQLSTATES, raises, translators })

if (problems.length > 0) {
  console.error('Private SQLSTATE registry problems:\n')
  for (const { rule, detail } of problems) console.error(`  [${rule}] ${detail}`)
  console.error(
    `\n${problems.length} problem(s). A code is an identity: one code, one rule, one entry in ` +
      'packages/db/src/sqlstate-registry.ts.',
  )
  process.exit(1)
}

const untranslated = PRIVATE_SQLSTATES.filter((entry) => entry.translators.length === 0).length
console.log(
  `${PRIVATE_SQLSTATES.length} private SQLSTATE(s) registered across ${corpus.size} migration(s); ` +
    `each is raised by exactly one migration's live definitions. ${untranslated} have no translator and ` +
    'reach their caller as a raw SQLSTATE.',
)
