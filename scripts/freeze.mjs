#!/usr/bin/env node
/**
 * The code freeze, and the merge rule derived from it.
 *
 * Two entry points on one file, because they are two questions about one artefact and a second script
 * would be a second place for the rules to live — `go-live-security.mjs`'s arrangement, one subject
 * over:
 *
 *   * `pnpm freeze` — `--register-only`. Is the register WELL FORMED: a closed state set, and the claim
 *     rule (a frozen tree names the role that froze it, the instant and the reason). In `pnpm verify`,
 *     because a malformed freeze register is a defect in the repository whatever the release position
 *     is, and because this one is cheap: two file reads and no database.
 *   * `node scripts/freeze.mjs --labels <csv>` — may this change be merged. Run by
 *     `.github/workflows/freeze.yml` on every pull request, with the labels the pull request carries.
 *     NOT in `pnpm verify`: a local commit has no labels, and a check that refused every local commit
 *     for want of a pull request would be switched off in a week.
 *
 * ## It is THIN on purpose
 *
 * Every judgement — the closed state set, the claim rule, the merge rule and the rendering — is in
 * `packages/core/src/release/freeze.ts` with a test per rule. A judgement that lives in a script is a
 * judgement no test reaches, which is the shape `ALERT_REGISTRY` was moved out of a script for.
 *
 * ## Nothing here decides the freeze
 *
 * There is no `--freeze` flag and no date arithmetic. The register holds a state a person set with
 * their role, the instant and their reason beside it, and declaring one is an edit to that file in a
 * commit somebody reviews. The cutover date is not on file (`Y13-cutover-date`), so a mechanism that
 * decided when to freeze would be deciding a date this build invented (brief rule 15).
 *
 * ## Exit codes
 *
 *   0  the register is well formed, and — outside `--register-only` — this change may be merged.
 *   1  a rule is broken. Every failure names the rule, so a gate case can assert the rule rather than a
 *      non-zero exit (ADR 0003).
 */
import { existsSync, readFileSync } from 'node:fs'
import {
  FREEZE_RULES,
  freezeProblems,
  LAUNCH_BLOCKING_LABEL,
  mergePermitted,
  parseFreezeRegister,
  renderFreeze,
} from '../packages/core/src/release/freeze.ts'

const DEFAULT_REGISTER = 'artifacts/release/freeze.json'

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : (argv[at + 1] ?? fallback)
}
const registerOnly = argv.includes('--register-only')
const registerPath = flag('register', DEFAULT_REGISTER)

/**
 * The labels, or `null` for *nobody looked*.
 *
 * `--labels ''` is an empty set — a pull request with no labels, which is a real state and is refused
 * during a freeze. Omitting the flag is the absence of label information, which is refused by its own
 * rule: the two are different claims and the distinction is the reason `mergePermitted` takes
 * `readonly string[] | null` rather than an array.
 */
const labelsFlag = argv.indexOf('--labels')
const labels =
  labelsFlag === -1
    ? null
    : (argv[labelsFlag + 1] ?? '')
        .split(',')
        .map((label) => label.trim())
        .filter((label) => label.length > 0)

if (!existsSync(registerPath)) {
  console.error(
    `[${FREEZE_RULES.malformed}] ${registerPath} does not exist. The register ships live and OPEN ` +
      'rather than absent, for the findings register’s reason (ADR 0125): one that is created on ' +
      'the day somebody needs it is one nobody has read, and a missing freeze register is ' +
      'indistinguishable from a tree nobody froze.',
  )
  process.exit(1)
}

let raw
try {
  raw = JSON.parse(readFileSync(registerPath, 'utf8'))
} catch (error) {
  console.error(
    `[${FREEZE_RULES.malformed}] ${registerPath} is not readable JSON: ${error.message}`,
  )
  process.exit(1)
}

const { register, problems } = parseFreezeRegister(raw, registerPath)
if (register === null) {
  for (const problem of problems) console.error(`[${problem.rule}] ${problem.detail}`)
  console.error(`\n${problems.length} problem(s) in ${registerPath}.`)
  process.exit(1)
}

if (registerOnly) {
  const shape = freezeProblems(register)
  if (shape.length > 0) {
    for (const problem of shape) console.error(`[${problem.rule}] ${problem.detail}`)
    console.error(
      `\n${shape.length} problem(s). A freeze is a claim a human makes, recorded with who and when: a ` +
        'frozen register naming no role, no instant and no reason records that somebody froze the tree.',
    )
    process.exit(1)
  }
  console.log(
    `Code freeze: ${register.state.toUpperCase()}` +
      (register.claim === null
        ? ` — no freeze has been declared and nothing in this build will declare one (${register.openQuestionId}).`
        : ` — declared by ${register.claim.declaredBy} at ${register.claim.declaredAtIso}.`) +
      ` A change is exempt only when it is labelled ${LAUNCH_BLOCKING_LABEL}.`,
  )
  process.exit(0)
}

const verdict = mergePermitted(register, labels)
console.log(renderFreeze(register, verdict))
process.exit(verdict.permitted ? 0 : 1)
