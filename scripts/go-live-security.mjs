#!/usr/bin/env node
/**
 * The security go/no-go check, and the findings register's integrity.
 *
 * Two entry points on one file, because they are two questions about one artefact and a second script
 * would be a second place for the rules to live:
 *
 *   * `pnpm findings` — `--register-only`. Is the register WELL FORMED: closed severity and status
 *     sets, and the closing rule. In `pnpm verify`, because a malformed register is a defect in the
 *     repository whatever the security position is.
 *   * `pnpm go-live:security` — the whole question. May this build go live. **NOT** in `pnpm verify`,
 *     and that is deliberate for `go-live-payments.mjs`'s stated reason: it exits non-zero today and is
 *     supposed to, because no penetration test has been performed. Putting it in `verify` would make
 *     every commit fail on a business fact nobody can fix in code, and the first response to a check
 *     like that is to delete it.
 *
 * ## It is THIN on purpose
 *
 * Every judgement — the closed sets, the closing rule, the verdict and the rendering — is in
 * `packages/core/src/security/findings.ts` with a test per rule, including the snapshot of the output
 * this script prints. A judgement that lives in a script is a judgement no test reaches, which is the
 * shape `ALERT_REGISTRY` was moved out of a script for.
 *
 * Usage: `node scripts/go-live-security.mjs [--register-only] [--register <path>]`
 */
import { existsSync, readFileSync } from 'node:fs'
import {
  FINDING_RULES,
  goNoGoVerdict,
  parseFindingsRegister,
  registerProblems,
  renderGoNoGo,
} from '../packages/core/src/security/findings.ts'

const DEFAULT_REGISTER = 'artifacts/security/findings.json'

const argv = process.argv.slice(2)
const flag = (name, fallback = null) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 ? fallback : (argv[at + 1] ?? fallback)
}
const registerOnly = argv.includes('--register-only')
const registerPath = flag('register', DEFAULT_REGISTER)

if (!existsSync(registerPath)) {
  console.error(
    `[${FINDING_RULES.malformed}] ${registerPath} does not exist. The register ships live and empty ` +
      'rather than absent: one that is created on the day somebody needs it is one nobody has read.',
  )
  process.exit(1)
}

let raw
try {
  raw = JSON.parse(readFileSync(registerPath, 'utf8'))
} catch (error) {
  console.error(
    `[${FINDING_RULES.malformed}] ${registerPath} is not readable JSON: ${error.message}`,
  )
  process.exit(1)
}

const { register, problems } = parseFindingsRegister(raw, registerPath)
if (register === null) {
  for (const problem of problems) console.error(`[${problem.rule}] ${problem.detail}`)
  console.error(`\n${problems.length} problem(s) in ${registerPath}.`)
  process.exit(1)
}

if (registerOnly) {
  const closing = registerProblems(register)
  if (closing.length > 0) {
    for (const problem of closing) console.error(`[${problem.rule}] ${problem.detail}`)
    console.error(
      `\n${closing.length} problem(s). A finding is closed with evidence or it is not closed: a commit ` +
        'or a test reference for a fix, a rationale and a role for an acceptance, a reason for a ' +
        'dismissal, an original for a duplicate.',
    )
    process.exit(1)
  }
  const unresolved = register.findings.filter((finding) =>
    ['open', 'triaged', 'in_progress'].includes(finding.status),
  )
  console.log(
    `Findings register: ${register.findings.length} finding(s), ${unresolved.length} unresolved, every ` +
      'severity and status in its closed set and every closed finding carrying its evidence. ' +
      `Engagement: ${register.engagement.booked ? 'performed' : `NOT performed (${register.engagement.openQuestionId})`}.`,
  )
  process.exit(0)
}

console.log(renderGoNoGo(register))
process.exit(goNoGoVerdict(register).go ? 0 : 1)
