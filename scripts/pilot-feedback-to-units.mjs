#!/usr/bin/env node
/**
 * Turns a pilot feedback log into manifest fix units, and refuses an item it cannot file.
 *
 * ```
 * tsx scripts/pilot-feedback-to-units.mjs                                      # the committed log
 * tsx scripts/pilot-feedback-to-units.mjs --file <log.json> --out units.yaml
 * ```
 *
 * ## Why it does not write into `build/manifest.yaml`
 *
 * It prints the fragment and `--out` writes it to a file. A script that edited the manifest itself would
 * be a script that adds units to the build's plan unreviewed — and the manifest is the one file every
 * agent in this build reads and every merge resolves. `build/manifest.yaml` has already been deleted
 * once by a helper that was pointed at it (see `withFixture`'s guard in `scripts/test-gates.mjs`). So the
 * last step is a person pasting a fragment they have read.
 *
 * ## What it refuses, and why refusing is the point
 *
 * An item with no id, no summary, no reporter, a repeated id, or a category outside the taxonomy is
 * REFUSED by name and the command exits non-zero. The thing reading the category writes a unit into the
 * build's plan: a free category would be a unit title nobody planned, and an unknown one answered with a
 * default would file somebody's complaint under the wrong heading and generate the wrong work.
 *
 * Two of the eight categories produce NO unit and are REPORTED per item rather than dropped —
 * `device_or_hardware`, which this build cannot change (Y14-devices), and `not_a_defect`, which is the
 * category that earns the taxonomy. An item that silently produced no unit is an item whoever reported it
 * will raise again.
 *
 * ## Exit codes
 *
 *   0  every item was filed: a unit, or a stated reason for none.
 *   1  at least one item was refused.
 *   2  the command could not run: no log, or a log that is not one.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { pilotFixUnitYaml, planPilotFeedback } from '../packages/core/src/pilot/feedback.ts'
import { PILOT_FEEDBACK_CATEGORIES } from '../packages/shared/src/parallel-run.ts'

const DEFAULT_LOG = 'artifacts/pilot/feedback.json'

const argv = process.argv.slice(2)
const flag = (name) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? undefined : argv[at + 1]
}

const file = flag('file') ?? DEFAULT_LOG

let parsed
try {
  parsed = JSON.parse(readFileSync(file, 'utf8'))
} catch (error) {
  console.error(`${file} could not be read as a pilot feedback log: ${error.message}`)
  process.exit(2)
}

if (!Array.isArray(parsed?.items)) {
  // Refused rather than treated as an empty log: "no items" and "the file has no items array" are
  // different facts, and the second one reported as the first is a pilot whose feedback silently
  // produced nothing.
  console.error(
    `${file} has no \`items\` array. Refused rather than read as an empty log: a log nothing could ` +
      'read reports the same "0 items" as a pilot nobody has run.',
  )
  process.exit(2)
}

const plan = planPilotFeedback(parsed.items)

const lines = []
lines.push(
  `# Generated from ${file} by scripts/pilot-feedback-to-units.mjs. Read it before pasting.`,
)
lines.push(
  `# ${parsed.items.length} item(s): ${plan.units.length} fix unit(s), ${plan.notUnits.length} ` +
    `recorded without one, ${plan.refused.length} refused.`,
)
if (parsed.pilotRan === false) {
  lines.push('# The log states the pilot has NOT run, so any item in it is synthetic (Y12-pilot).')
}
for (const unit of plan.units) lines.push(pilotFixUnitYaml(unit))

const out = flag('out')
if (out) {
  writeFileSync(out, `${lines.join('\n')}\n`)
  console.log(`${plan.units.length} fix unit(s) written to ${out}`)
} else {
  console.log(lines.join('\n'))
}

for (const entry of plan.notUnits) {
  console.log(`  no unit  ${entry.feedbackId}  [${entry.category}]  ${entry.reason}`)
}
for (const entry of plan.refused) {
  console.error(`  REFUSED  item ${entry.at}  ${entry.reason}`)
}

if (plan.refused.length > 0) {
  console.error(
    `\n${plan.refused.length} item(s) could not be filed. The taxonomy is ` +
      `${PILOT_FEEDBACK_CATEGORIES.map((entry) => entry.category).join(', ')}.`,
  )
  process.exit(1)
}

console.log(
  `\n${plan.units.length} fix unit(s), ${plan.notUnits.length} item(s) recorded without one, nothing ` +
    'refused.',
)
