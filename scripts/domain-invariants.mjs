#!/usr/bin/env node
/**
 * The four domain invariants of docs/14 §3, re-derived over every row the database holds.
 *
 * `pnpm domain-invariants`. B-M1, and docs/14 §3's own instruction: *"Domain invariants are the
 * non-negotiable subset, and they run on every unit regardless of what changed."* So it is a step of
 * `pnpm verify` — immediately after `pnpm money-invariants`, which is immediately after the
 * integration suite, because that is what writes the estate both censuses examine — and a CI job of
 * its own, which is what the acceptance line asks for.
 *
 * ## It is THIN on purpose
 *
 * The claim list, the rule names, the floors and the rendering are
 * `packages/core/src/ops/domain-invariants.ts`; the five queries are
 * `packages/fixtures/src/domain-invariants.ts`. A judgement that lives in a script is a judgement no
 * test reaches, which is the shape `ALERT_REGISTRY` was moved out of a script for.
 *
 * ## Why a census and not a registry of tests
 *
 * Each of the four is already enforced — an exclusion constraint, a capacity trigger, the availability
 * solver — and what nothing checked is whether the estate those guards protect actually holds. A row
 * planted with a constraint dropped, written before the guard existed, or imported from the previous
 * arrangement (`appointment.migrated`) satisfies every test in the repository and breaks the claim.
 * `packages/fixtures/src/domain-invariants.itest.ts` plants one such row per claim and watches each
 * refusal fire (ADR 0003).
 *
 * ## Exit codes
 *
 *   0  all four hold, over a census that examined something.
 *   1  any breach, or a census that examined nothing. Every failure names the rule (ADR 0003).
 *   2  the command could not run: no database.
 */
import {
  domainInvariantProblems,
  renderDomainInvariantCensus,
} from '../packages/core/src/ops/domain-invariants.ts'
import { createConnection } from '../packages/db/src/connection.ts'
import { censusDomainInvariants } from '../packages/fixtures/src/domain-invariants.ts'

const url = process.env['DATABASE_URL'] ?? process.env['TEST_DATABASE_URL']
if (url === undefined || url === '') {
  console.error(
    'DATABASE_URL or TEST_DATABASE_URL is required. These four claims are about the ESTATE, so there ' +
      'is nothing to say without one — and a run that skipped would report success.',
  )
  process.exit(2)
}

const sql = createConnection({ url, max: 2 })
let census
try {
  census = await censusDomainInvariants(sql)
} finally {
  await sql.end({ timeout: 5 })
}

const problems = domainInvariantProblems(census)
console.log(renderDomainInvariantCensus(census, problems))
if (problems.length > 0) {
  console.error(
    `\n${problems.length} problem(s). docs/14 §3 calls these four non-negotiable: a double-booked ` +
      'therapist is two clients and one pair of hands, a room over capacity is people in a room that ' +
      'does not hold them, and an appointment on the wrong business day puts the takings on the wrong ' +
      "day's cash-up.",
  )
}
process.exit(problems.length > 0 ? 1 : 0)
